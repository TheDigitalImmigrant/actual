import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Error as ErrorAlert } from '#components/alerts';
import { Link } from '#components/common/Link';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { FormField, FormLabel } from '#components/forms';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { getSecretsError } from '#util/error';

type TrueLayerInitialiseProps = Extract<
  ModalType,
  { name: 'truelayer-init' }
>['options'];

export function TrueLayerInitialiseModal({
  onSuccess,
}: TrueLayerInitialiseProps) {
  const { t } = useTranslation();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [isValid, setIsValid] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(
    t('It is required to provide both the client ID and client secret.'),
  );

  async function onSubmit(close: () => void) {
    if (!clientId || !clientSecret) {
      setIsValid(false);
      setError(
        t('It is required to provide both the client ID and client secret.'),
      );
      return;
    }

    setIsLoading(true);

    let { error, reason } =
      (await send('secret-set', {
        name: 'truelayer_clientId',
        value: clientId,
      })) || {};

    if (error) {
      setIsLoading(false);
      setIsValid(false);
      setError(getSecretsError(error, reason));
      return;
    }

    ({ error, reason } =
      (await send('secret-set', {
        name: 'truelayer_clientSecret',
        value: clientSecret,
      })) || {});

    if (error) {
      setIsLoading(false);
      setIsValid(false);
      setError(getSecretsError(error, reason));
      return;
    }

    setIsValid(true);
    onSuccess();
    setIsLoading(false);
    close();
  }

  return (
    <Modal
      name="truelayer-init"
      containerProps={{ style: { width: '30vw', minWidth: 420 } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Set up TrueLayer')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            <Text>
              <Trans>
                In order to enable bank sync via TrueLayer (for UK and EU banks)
                you will need to create application credentials. This can be done
                by creating an account at{' '}
                <Link
                  variant="external"
                  to="https://console.truelayer.com/"
                  linkColor="purple"
                >
                  TrueLayer
                </Link>
                .
              </Trans>
            </Text>

            <Text>
              <Trans>
                When setting up your application, use the following as the
                redirect URL:
              </Trans>{' '}
              <code>{window.location.origin}/truelayer/auth_callback</code>
            </Text>

            {window.location.protocol === 'http:' && (
              <ErrorAlert>
                <Trans>
                  TrueLayer requires HTTPS for the redirect URL. Your current
                  connection is not secure.
                </Trans>
              </ErrorAlert>
            )}

            <FormField>
              <FormLabel title={t('Client ID:')} htmlFor="client-id-field" />
              <InitialFocus>
                <Input
                  id="client-id-field"
                  type="password"
                  value={clientId}
                  onChangeValue={value => {
                    setClientId(value);
                    setIsValid(true);
                  }}
                />
              </InitialFocus>
            </FormField>

            <FormField>
              <FormLabel
                title={t('Client Secret:')}
                htmlFor="client-secret-field"
              />
              <Input
                id="client-secret-field"
                type="password"
                value={clientSecret}
                onChangeValue={value => {
                  setClientSecret(value);
                  setIsValid(true);
                }}
              />
            </FormField>

            {!isValid && <ErrorAlert>{error}</ErrorAlert>}
          </View>

          <ModalButtons>
            <ButtonWithLoading
              variant="primary"
              isLoading={isLoading}
              onPress={() => {
                void onSubmit(() => state.close());
              }}
            >
              <Trans>Save and continue</Trans>
            </ButtonWithLoading>
          </ModalButtons>
        </>
      )}
    </Modal>
  );
}
