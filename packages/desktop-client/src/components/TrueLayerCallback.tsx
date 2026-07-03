import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Paragraph } from '@actual-app/components/paragraph';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Error as ErrorAlert } from '#components/alerts';
import { useUrlParam } from '#hooks/useUrlParam';

export function TrueLayerCallback() {
  const { t } = useTranslation();
  const [code] = useUrlParam('code');
  const [stateParam] = useUrlParam('state');
  const [errorParam] = useUrlParam('error');
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>(
    'loading',
  );
  const [errorMessage, setErrorMessage] = useState('');
  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    async function handleCallback() {
      if (errorParam) {
        setStatus('error');
        setErrorMessage(
          t('Authorization was denied or failed: {{error}}', {
            error: errorParam,
          }),
        );
        return;
      }

      if (!code || !stateParam) {
        setStatus('error');
        setErrorMessage(t('Missing authorization parameters.'));
        return;
      }

      // The server validates `state` against its pending-links map (and
      // create-web-token is behind the user's token), so it is the authority
      // here. We don't gate on a localStorage match because mobile browsers
      // (e.g. Brave) isolate storage between the popup tab and the opener.
      try {
        const result = await send('truelayer-complete-auth', {
          code,
          state: stateParam,
        });

        if (result.error) {
          setStatus('error');
          setErrorMessage(
            result.error.message || t('Failed to complete authorization.'),
          );
          return;
        }

        setStatus('success');
        localStorage.removeItem('truelayer_auth_state');

        // Best-effort auto-close; mobile browsers usually block window.close()
        // for tabs the script didn't open, so the success message tells the
        // user to return to Actual (where the account picker is waiting).
        setTimeout(() => {
          window.close();
        }, 1500);
      } catch {
        setStatus('error');
        setErrorMessage(t('An unexpected error occurred.'));
      }
    }

    void handleCallback();
  }, [code, stateParam, errorParam, t]);

  return (
    <View
      style={{
        padding: 20,
        maxWidth: 500,
        margin: '40px auto',
        textAlign: 'center',
      }}
    >
      {status === 'loading' && (
        <Paragraph>
          <Trans>Completing authorization...</Trans>
        </Paragraph>
      )}

      {status === 'success' && (
        <Paragraph>
          <Trans>
            Authorization successful! You can close this tab and return to
            Actual to choose which accounts to link.
          </Trans>
        </Paragraph>
      )}

      {status === 'error' && (
        <>
          <ErrorAlert>{errorMessage}</ErrorAlert>
          <Paragraph style={{ marginTop: 10 }}>
            <Trans>You can close this window and try again.</Trans>
          </Paragraph>
        </>
      )}
    </View>
  );
}
