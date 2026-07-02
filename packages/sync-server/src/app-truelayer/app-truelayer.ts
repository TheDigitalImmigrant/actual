import createDebug from 'debug';
import type { Request, Response } from 'express';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';

import { handleError } from '#app-gocardless/util/handle-error';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';

import { TrueLayerError } from './utils/errors';
import { trueLayerService } from './services/truelayer-service';

const debug = createDebug('actual:truelayer:app');

// Escape untrusted text before interpolating into an HTML response (the OAuth
// callback reflects query params, which are attacker-controllable).
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const app = express();
export { app as handlers };
app.use(requestLoggerMiddleware);
app.use(express.json());

// --- OAuth handoff coordination (process-local, mirrors Enable Banking) ---
// Maps the OAuth `state` to the connection being established so the redirect
// callback and the client poll can rendezvous. Multi-instance deployments would
// need sticky routing so the same instance handles both.
type PendingLink = { connectionId: string; redirectUri: string };
const pendingLinks = new Map<string, PendingLink>();
const completedLinks = new Map<string, unknown>();
const COMPLETED_TTL_MS = 5 * 60 * 1000;

// The bank redirects here directly with no auth token, so this route is
// registered before validateSessionMiddleware.
app.get('/auth_callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state =
    typeof req.query.state === 'string' ? req.query.state : undefined;

  // eslint-disable-next-line no-console -- diagnostic for live validation
  console.log(
    '[truelayer] auth_callback hit; query keys=%s hasCode=%s state=%s',
    Object.keys(req.query).join(','),
    !!code,
    state,
  );

  if (!code || !state) {
    // TrueLayer may redirect with error/error_description instead of a code.
    const errText =
      typeof req.query.error_description === 'string'
        ? req.query.error_description
        : typeof req.query.error === 'string'
          ? req.query.error
          : 'missing code or state';
    // eslint-disable-next-line no-console -- diagnostic for live validation
    console.log('[truelayer] auth_callback missing code/state: %s', errText);
    res
      .status(400)
      .send(
        `<html><body><p>Authorization failed: ${escapeHtml(errText)}</p></body></html>`,
      );
    return;
  }

  const pending = pendingLinks.get(state);
  if (!pending) {
    // eslint-disable-next-line no-console -- diagnostic for live validation
    console.log('[truelayer] auth_callback unknown state: %s', state);
    res
      .status(400)
      .send('<html><body><p>Authorization failed: unknown or expired state.</p></body></html>');
    return;
  }

  try {
    await trueLayerService.completeAuth(
      code,
      pending.redirectUri,
      pending.connectionId,
    );
    const accounts = await trueLayerService.getAccountsAndCards(
      pending.connectionId,
    );
    // eslint-disable-next-line no-console -- diagnostic for live validation
    console.log(
      '[truelayer] connection established: %s accounts=%d',
      pending.connectionId,
      accounts.length,
    );
    // Tag each account with its connection so the client stores it as the
    // account's requisitionId, exactly like GoCardless.
    const result = {
      requisitionId: pending.connectionId,
      accounts: accounts.map(a => ({ ...a, requisitionId: pending.connectionId })),
    };
    completedLinks.set(state, result);
    setTimeout(() => completedLinks.delete(state), COMPLETED_TTL_MS);
    pendingLinks.delete(state);

    res.send(
      '<html><body><p>Authorization successful. This window will close.</p>' +
        '<script>setTimeout(function(){window.close()},1000)</script></body></html>',
    );
  } catch (error) {
    debug('auth_callback error: %s', error);
    // eslint-disable-next-line no-console -- diagnostic for live validation
    console.log('[truelayer] auth_callback error:', error);
    completedLinks.set(state, {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    setTimeout(() => completedLinks.delete(state), COMPLETED_TTL_MS);
    pendingLinks.delete(state);
    res
      .status(500)
      .send('<html><body><p>Authorization failed. Close this window and try again.</p></body></html>');
  }
});

app.use(validateSessionMiddleware);

// --- Routes ---

app.post(
  '/status',
  handleError(async (_req: Request, res: Response) => {
    res.send({
      status: 'ok',
      data: { configured: trueLayerService.isConfigured() },
    });
  }),
);

// Bank picker: list providers for a country (defaults to GB).
app.post(
  '/get-banks',
  handleError(async (req: Request, res: Response) => {
    const { country } = req.body || {};
    const providers = await trueLayerService.getProviders(
      typeof country === 'string' ? country : 'uk',
    );
    res.send({ status: 'ok', data: providers });
  }),
);

// Begin linking a specific bank: returns the hosted TrueLayer auth URL.
app.post(
  '/create-web-token',
  handleError(async (req: Request, res: Response) => {
    const { providerId, redirectUri } = req.body || {};
    if (!providerId || !redirectUri) {
      res.send({
        status: 'ok',
        data: { error: 'Missing providerId or redirectUri' },
      });
      return;
    }
    const state = uuidv4();
    const connectionId = uuidv4();
    pendingLinks.set(state, { connectionId, redirectUri });
    const link = trueLayerService.buildAuthUrl(providerId, redirectUri, state);
    res.send({ status: 'ok', data: { link, state, requisitionId: connectionId } });
  }),
);

// Poll for the linked accounts once the user finishes the hosted auth flow.
app.post(
  '/get-accounts',
  handleError(async (req: Request, res: Response) => {
    const { state } = req.body || {};
    if (!state) {
      res.send({ status: 'ok', data: { error: 'Missing state' } });
      return;
    }
    const result = completedLinks.get(state);
    if (result) {
      completedLinks.delete(state);
      res.send({ status: 'ok', data: result });
    } else {
      // Not finished yet — client keeps polling.
      res.send({ status: 'ok', data: { pending: true } });
    }
  }),
);

app.post(
  '/remove-account',
  handleError(async (req: Request, res: Response) => {
    const { requisitionId } = req.body || {};
    if (requisitionId) trueLayerService.removeConnection(requisitionId);
    res.send({ status: 'ok', data: { removed: true } });
  }),
);

app.post(
  '/transactions',
  handleError(async (req: Request, res: Response) => {
    const { requisitionId, accountId, startDate, providerId } = req.body || {};
    if (!requisitionId || !accountId) {
      res.send({
        status: 'ok',
        data: { error_type: 'INVALID_INPUT', error_code: 'INVALID_INPUT' },
      });
      return;
    }

    const dateTo = new Date().toISOString().slice(0, 10);
    const dateFrom =
      typeof startDate === 'string'
        ? startDate.slice(0, 10)
        : new Date(startDate).toISOString().slice(0, 10);

    // Auto-detect account vs card: TrueLayer serves them from different
    // resource paths, and the sync only knows the account id.
    try {
      let result;
      try {
        result = await trueLayerService.getTransactions(
          requisitionId,
          accountId,
          'account',
          dateFrom,
          dateTo,
          providerId,
        );
      } catch (error) {
        if (error instanceof TrueLayerError && error.error_code === 'NOT_FOUND') {
          result = await trueLayerService.getTransactions(
            requisitionId,
            accountId,
            'card',
            dateFrom,
            dateTo,
            providerId,
          );
        } else {
          throw error;
        }
      }

      res.send({
        status: 'ok',
        data: {
          transactions: {
            all: result.all,
            booked: result.booked,
            pending: result.pending,
          },
          balances: result.balances,
          startingBalance: result.startingBalance,
        },
      });
    } catch (error) {
      debug('transactions error: %s', error);
      if (
        error instanceof TrueLayerError &&
        error.error_code === 'INVALID_ACCESS_TOKEN'
      ) {
        // Surfaces as an account sync error prompting re-link (90-day consent
        // or refresh-token expiry), matching every other provider.
        res.send({
          status: 'ok',
          data: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' },
        });
        return;
      }
      const code =
        error instanceof TrueLayerError ? error.error_code : 'INTERNAL_ERROR';
      res.send({ status: 'ok', data: { error_type: code, error_code: code } });
    }
  }),
);
