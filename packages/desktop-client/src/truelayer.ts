import { sendCatch } from '@actual-app/core/platform/client/connection';
import type {
  AccountEntity,
  SyncServerTrueLayerAccount,
} from '@actual-app/core/types/models';
import { t } from 'i18next';

import { pushModal } from '#modals/modalsSlice';
import type { AppDispatch } from '#redux/store';

function _authorize(
  dispatch: AppDispatch,
  {
    onSuccess,
    onClose,
  }: {
    onSuccess: (data: {
      accounts: SyncServerTrueLayerAccount[];
    }) => Promise<void>;
    onClose?: () => void;
  },
) {
  dispatch(
    pushModal({
      modal: {
        name: 'truelayer-external-msg',
        options: {
          onMoveExternal: async ({ providerId, onStateReady }) => {
            const redirectUrl = `${window.location.origin}/truelayer/auth_callback`;
            const resp = await sendCatch('truelayer-start-auth', {
              providerId,
              redirectUrl,
            });

            if (resp.error) {
              return {
                error: 'unknown' as const,
                message: resp.error.message,
              };
            }

            const authData = resp.data;

            if (authData?.error) {
              return {
                error: 'unknown' as const,
                message: authData.error,
              };
            }

            const authUrl = authData?.link;
            const state = authData?.state;

            if (!authUrl || !state) {
              return {
                error: 'unknown' as const,
                message: t('Missing auth URL or state'),
              };
            }

            localStorage.setItem('truelayer_auth_state', state);
            onStateReady?.(state);
            window.open(
              authUrl,
              'truelayer-auth',
              'width=600,height=700,popup=yes',
            );

            try {
              const pollResp = await sendCatch('truelayer-poll-auth', {
                state,
              });

              if (pollResp.error) {
                if (pollResp.error.message === 'timeout') {
                  return { error: 'timeout' as const };
                }

                return {
                  error: 'unknown' as const,
                  message: pollResp.error.message,
                };
              }

              const pollData = pollResp.data;

              // The poll response body itself may carry an error (e.g. when
              // the bank callback failed before the poll started).
              if (pollData?.error) {
                return {
                  error: 'unknown' as const,
                  message:
                    typeof pollData.error === 'string'
                      ? pollData.error
                      : String(pollData.error),
                };
              }

              const accounts: SyncServerTrueLayerAccount[] =
                pollData?.accounts ?? [];

              return { data: { accounts } };
            } finally {
              // Only clear if this attempt's state is still the one stored;
              // a concurrent retry may have overwritten it with a newer one.
              if (localStorage.getItem('truelayer_auth_state') === state) {
                localStorage.removeItem('truelayer_auth_state');
              }
            }
          },
          onClose,
          onSuccess,
        },
      },
    }),
  );
}

export async function authorizeBank(
  dispatch: AppDispatch,
  upgradingAccountId?: AccountEntity['id'],
) {
  _authorize(dispatch, {
    onSuccess: async data => {
      dispatch(
        pushModal({
          modal: {
            name: 'select-linked-accounts',
            options: {
              externalAccounts: data.accounts,
              syncSource: 'trueLayer',
              upgradingAccountId,
            },
          },
        }),
      );
    },
  });
}
