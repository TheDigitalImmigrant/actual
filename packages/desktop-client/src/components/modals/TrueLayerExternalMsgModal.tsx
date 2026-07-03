import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { AnimatedLoading } from '@actual-app/components/icons/AnimatedLoading';
import { Paragraph } from '@actual-app/components/paragraph';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { sendCatch } from '@actual-app/core/platform/client/connection';
import type {
  SyncServerTrueLayerAccount,
  TrueLayerProvider,
} from '@actual-app/core/types/models';

import { Error, Warning } from '#components/alerts';
import { Autocomplete } from '#components/autocomplete/Autocomplete';
import { Link } from '#components/common/Link';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FormField, FormLabel } from '#components/forms';
import { COUNTRY_OPTIONS } from '#components/util/countries';
import { getCountryFromBrowser } from '#components/util/localeToCountry';
import { useGlobalPref } from '#hooks/useGlobalPref';
import { useTrueLayerStatus } from '#hooks/useTrueLayerStatus';
import { pushModal } from '#modals/modalsSlice';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

type BankOption = {
  id: string;
  name: string;
};

// TrueLayer uses lowercase country codes and "uk" (not "gb").
function toTrueLayerCountry(country: string) {
  const lower = country.toLowerCase();
  return lower === 'gb' ? 'uk' : lower;
}

function useAvailableBanks(
  country: string | undefined,
  refetchKey?: boolean | null,
) {
  const [banks, setBanks] = useState<BankOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetch() {
      setIsError(false);

      if (!country) {
        if (!cancelled) {
          setBanks([]);
          setIsLoading(false);
        }
        return;
      }

      setIsLoading(true);

      const { data, error } = await sendCatch(
        'truelayer-get-banks',
        toTrueLayerCountry(country),
      );

      if (cancelled) return;

      if (error) {
        setIsError(true);
        setBanks([]);
      } else {
        const providers: TrueLayerProvider[] = data ?? [];
        setBanks(
          providers.map(provider => ({
            id: provider.provider_id,
            name: provider.display_name,
          })),
        );
      }

      setIsLoading(false);
    }

    void fetch();
    return () => {
      cancelled = true;
    };
  }, [country, refetchKey]);

  return {
    data: banks,
    isLoading,
    isError,
  };
}

function renderError(
  error: { code: 'unknown' | 'timeout'; message?: string },
  t: ReturnType<typeof useTranslation>['t'],
) {
  return (
    <Error style={{ alignSelf: 'center', marginBottom: 10 }}>
      {error.code === 'timeout'
        ? t('Timed out. Please try again.')
        : t(
            'An error occurred while linking your account, sorry! The potential issue could be: {{ message }}',
            { message: error.message },
          )}
    </Error>
  );
}

type TrueLayerExternalMsgModalProps = Extract<
  ModalType,
  { name: 'truelayer-external-msg' }
>['options'];

export function TrueLayerExternalMsgModal({
  onMoveExternal,
  onSuccess,
  onClose,
}: TrueLayerExternalMsgModalProps) {
  const { t } = useTranslation();

  const dispatch = useDispatch();
  const [language] = useGlobalPref('language');

  const browserTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const browserLocale = language || navigator.language || 'en-GB';
  const detectedCountry =
    getCountryFromBrowser(browserTimezone, browserLocale, COUNTRY_OPTIONS) ||
    'GB';

  const [waiting, setWaiting] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>();
  const [country, setCountry] = useState<string | undefined>(detectedCountry);
  const [error, setError] = useState<{
    code: 'unknown' | 'timeout';
    message?: string;
  } | null>(null);
  const [isTrueLayerSetupComplete, setIsTrueLayerSetupComplete] = useState<
    boolean | null
  >(null);
  const data = useRef<{ accounts: SyncServerTrueLayerAccount[] } | null>(null);

  const {
    data: bankOptions,
    isLoading: isBankOptionsLoading,
    isError: isBankOptionError,
  } = useAvailableBanks(country, isTrueLayerSetupComplete);
  const {
    configuredTrueLayer: isConfigured,
    isLoading: isConfigurationLoading,
  } = useTrueLayerStatus();

  const isJumpingRef = useRef(false);
  const stateRef = useRef<string | null>(null);
  // Each onJump call captures a token from this counter. A retry that
  // supersedes an in-flight call increments the counter, so the older call
  // can detect it has been superseded and skip its post-await writes
  // instead of clobbering the newer attempt's UI state and refs.
  const jumpIdRef = useRef(0);

  async function handleClose() {
    if (stateRef.current !== null) {
      await sendCatch('truelayer-poll-auth-stop', {
        state: stateRef.current,
      });
    }
    onClose?.();
  }

  async function onJump() {
    const myJumpId = ++jumpIdRef.current;

    if (isJumpingRef.current) {
      // Abort the in-flight poll so we can re-open the popup immediately.
      // Only send the stop RPC if we have a state to target; if onMoveExternal
      // hasn't set stateRef yet there is no active poll to abort.
      if (stateRef.current !== null) {
        await sendCatch('truelayer-poll-auth-stop', {
          state: stateRef.current,
        });
      }
      isJumpingRef.current = false;
    }
    isJumpingRef.current = true;

    try {
      setError(null);
      setWaiting('browser');

      if (!selectedProvider) return;

      const res = await onMoveExternal({
        providerId: selectedProvider,
        onStateReady: state => {
          if (myJumpId === jumpIdRef.current) {
            stateRef.current = state;
          }
        },
      });

      // A retry has superseded this call — drop the result so it can't
      // overwrite the newer attempt's error or waiting state.
      if (myJumpId !== jumpIdRef.current) return;

      if ('error' in res) {
        setError({
          code: res.error,
          message: 'message' in res ? res.message : undefined,
        });
        setWaiting(null);
        return;
      }

      data.current = res.data;
      setWaiting('accounts');
      await onSuccess(data.current);
      if (myJumpId !== jumpIdRef.current) return;
      setWaiting(null);
    } finally {
      if (myJumpId === jumpIdRef.current) {
        isJumpingRef.current = false;
        stateRef.current = null;
      }
    }
  }

  const onTrueLayerInit = () => {
    dispatch(
      pushModal({
        modal: {
          name: 'truelayer-init',
          options: {
            onSuccess: () => setIsTrueLayerSetupComplete(true),
          },
        },
      }),
    );
  };

  const renderLinkButton = () => {
    return (
      <View style={{ gap: 10 }}>
        <FormField>
          <FormLabel
            title={t('Choose your country:')}
            htmlFor="country-field"
          />
          <Autocomplete
            strict
            highlightFirst
            suggestions={COUNTRY_OPTIONS}
            onSelect={value => {
              setCountry(value);
              setSelectedProvider(undefined);
            }}
            value={country}
            inputProps={{
              id: 'country-field',
              placeholder: t('(please select)'),
            }}
          />
        </FormField>

        {isBankOptionError ? (
          <Error>
            <Trans>
              Failed loading available banks: TrueLayer access credentials might
              be misconfigured. Please{' '}
              <Link
                variant="text"
                onClick={onTrueLayerInit}
                style={{ color: theme.formLabelText, display: 'inline' }}
              >
                set them up
              </Link>{' '}
              again.
            </Trans>
          </Error>
        ) : (
          country &&
          (isBankOptionsLoading ? (
            t('Loading banks...')
          ) : (
            <FormField>
              <FormLabel title={t('Choose your bank:')} htmlFor="bank-field" />
              <Autocomplete
                focused
                strict
                highlightFirst
                suggestions={bankOptions}
                onSelect={setSelectedProvider}
                value={selectedProvider}
                inputProps={{
                  id: 'bank-field',
                  placeholder: t('(please select)'),
                }}
              />
            </FormField>
          ))
        )}

        <Warning>
          <Trans>
            By enabling bank sync, you will be granting TrueLayer (a third party
            service) read-only access to your entire account's transaction
            history. This service is not affiliated with Actual in any way. Make
            sure you've read and understand TrueLayer's{' '}
            <Link
              variant="external"
              to="https://truelayer.com/privacy/"
              linkColor="purple"
            >
              Privacy Policy
            </Link>{' '}
            before proceeding.
          </Trans>
        </Warning>

        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Button
            variant="primary"
            autoFocus
            style={{
              padding: '10px 0',
              fontSize: 15,
              fontWeight: 600,
              flexGrow: 1,
            }}
            onPress={onJump}
            isDisabled={!selectedProvider || !country}
          >
            <Trans>Link bank in browser</Trans> &rarr;
          </Button>
        </View>
      </View>
    );
  };

  return (
    <Modal
      name="truelayer-external-msg"
      onClose={handleClose}
      containerProps={{ style: { width: '30vw' } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Link Your Bank')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View>
            <Paragraph style={{ fontSize: 15 }}>
              <Trans>
                To link your bank account, you will be redirected to a new page
                where TrueLayer will ask to connect to your bank. TrueLayer will
                not be able to withdraw funds from your accounts.
              </Trans>
            </Paragraph>

            {error && renderError(error, t)}

            {waiting || isConfigurationLoading ? (
              <View style={{ alignItems: 'center', marginTop: 15 }}>
                <AnimatedLoading
                  color={theme.pageTextDark}
                  style={{ width: 20, height: 20 }}
                />
                <View style={{ marginTop: 10, color: theme.pageText }}>
                  {isConfigurationLoading
                    ? t('Checking TrueLayer configuration...')
                    : waiting === 'browser'
                      ? t('Waiting on TrueLayer...')
                      : waiting === 'accounts'
                        ? t('Loading accounts...')
                        : null}
                </View>

                {waiting === 'browser' && (
                  <Link
                    variant="text"
                    onClick={onJump}
                    style={{ marginTop: 10 }}
                  >
                    (
                    <Trans>
                      Account linking not opening in a new tab? Click here
                    </Trans>
                    )
                  </Link>
                )}
              </View>
            ) : isConfigured || isTrueLayerSetupComplete ? (
              renderLinkButton()
            ) : (
              <>
                <Paragraph style={{ color: theme.errorText }}>
                  <Trans>
                    TrueLayer integration has not yet been configured.
                  </Trans>
                </Paragraph>
                <Button variant="primary" onPress={onTrueLayerInit}>
                  <Trans>Configure TrueLayer integration</Trans>
                </Button>
              </>
            )}
          </View>
        </>
      )}
    </Modal>
  );
}
