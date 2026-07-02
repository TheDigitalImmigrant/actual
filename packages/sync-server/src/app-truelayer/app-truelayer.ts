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
// The browser is redirected to a *frontend* route (the SPA), which reads the
// code+state and calls `/complete-auth` via RPC; meanwhile the opener long-polls
// `/get-accounts`. `pendingLinks` holds the connection being established;
// `completedLinks` caches the finished result; `pendingPolls` lets a waiting
// poll resolve the moment `complete-auth` fires. Multi-instance deployments
// would need sticky routing so one instance handles both sides.
type PendingLink = { connectionId: string; redirectUri: string };
type PendingPoll = {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pendingLinks = new Map<string, PendingLink>();
const completedLinks = new Map<string, unknown>();
const pendingPolls = new Map<string, PendingPoll>();
const COMPLETED_TTL_MS = 5 * 60 * 1000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

// Exchange the code, fetch accounts+cards, cache the result under `state`, and
// wake any waiting poll. Shared by POST /complete-auth (primary, from the SPA
// callback) and GET /auth_callback (fallback for non-PWA contexts).
async function finalizeAuth(code: string, state: string): Promise<unknown> {
  const pending = pendingLinks.get(state);
  if (!pending) {
    throw new TrueLayerError(
      'INVALID_INPUT',
      'UNKNOWN_STATE',
      'Unknown or expired state',
    );
  }

  let result: unknown;
  try {
    await trueLayerService.completeAuth(
      code,
      pending.redirectUri,
      pending.connectionId,
    );
    const accounts = await trueLayerService.getAccountsAndCards(
      pending.connectionId,
    );
    // Tag each account with its connection so the client stores it as the
    // account's requisitionId, exactly like GoCardless.
    result = {
      requisitionId: pending.connectionId,
      accounts: accounts.map(a => ({
        ...a,
        requisitionId: pending.connectionId,
      })),
    };
  } catch (error) {
    debug('finalizeAuth error: %s', error);
    result = { error: error instanceof Error ? error.message : 'unknown error' };
  }

  pendingLinks.delete(state);
  completedLinks.set(state, result);
  setTimeout(() => completedLinks.delete(state), COMPLETED_TTL_MS);

  const waiter = pendingPolls.get(state);
  if (waiter) {
    clearTimeout(waiter.timer);
    pendingPolls.delete(state);
    waiter.resolve(result);
  }
  return result;
}

// Fallback: the bank/redirect hitting the server directly (no PWA service
// worker). Registered before validateSessionMiddleware since there's no token.
app.get('/auth_callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state =
    typeof req.query.state === 'string' ? req.query.state : undefined;

  if (!code || !state) {
    const errText =
      typeof req.query.error_description === 'string'
        ? req.query.error_description
        : typeof req.query.error === 'string'
          ? req.query.error
          : 'missing code or state';
    res
      .status(400)
      .send(
        `<html><body><p>Authorization failed: ${escapeHtml(errText)}</p></body></html>`,
      );
    return;
  }

  try {
    await finalizeAuth(code, state);
    res.send(
      '<html><body><p>Authorization successful. This window will close.</p>' +
        '<script>setTimeout(function(){window.close()},1000)</script></body></html>',
    );
  } catch {
    res
      .status(400)
      .send(
        '<html><body><p>Authorization failed. Close this window and try again.</p></body></html>',
      );
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

// Primary completion path: the SPA callback component posts the code+state here
// (the browser redirect lands on the frontend route, not the server).
app.post(
  '/complete-auth',
  handleError(async (req: Request, res: Response) => {
    const { code, state } = req.body || {};
    if (!code || !state) {
      res.send({ status: 'ok', data: { error: 'Missing code or state' } });
      return;
    }
    const result = await finalizeAuth(code, state);
    res.send({ status: 'ok', data: result });
  }),
);

// Long-poll for the linked accounts: resolves as soon as complete-auth fires
// (or immediately if it already did), else times out so the client can retry.
app.post(
  '/get-accounts',
  handleError(async (req: Request, res: Response) => {
    const { state } = req.body || {};
    if (!state) {
      res.send({ status: 'ok', data: { error: 'Missing state' } });
      return;
    }

    const cached = completedLinks.get(state);
    if (cached) {
      completedLinks.delete(state);
      res.send({ status: 'ok', data: cached });
      return;
    }

    const result = await new Promise(resolve => {
      const existing = pendingPolls.get(state);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve({ pending: true });
      }
      const timer = setTimeout(() => {
        pendingPolls.delete(state);
        resolve({ pending: true });
      }, POLL_TIMEOUT_MS);
      pendingPolls.set(state, { resolve, timer });
      res.on('close', () => {
        const w = pendingPolls.get(state);
        if (w && w.timer === timer) {
          clearTimeout(timer);
          pendingPolls.delete(state);
        }
      });
    });

    if (!res.writableEnded) {
      res.send({ status: 'ok', data: result });
    }
  }),
);

// Cancel a waiting poll (e.g. user closed the link modal).
app.post(
  '/poll-stop',
  handleError(async (req: Request, res: Response) => {
    const { state } = req.body || {};
    const waiter = state && pendingPolls.get(state);
    if (waiter) {
      clearTimeout(waiter.timer);
      pendingPolls.delete(state);
      waiter.resolve({ pending: true });
    }
    res.send({ status: 'ok', data: { stopped: true } });
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
