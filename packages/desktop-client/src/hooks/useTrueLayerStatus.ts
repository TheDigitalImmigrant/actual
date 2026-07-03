import { useEffect, useState } from 'react';

import { send } from '@actual-app/core/platform/client/connection';

import { useSyncServerStatus } from './useSyncServerStatus';

export function useTrueLayerStatus() {
  const [configuredTrueLayer, setConfiguredTrueLayer] = useState<
    boolean | null
  >(null);
  const [isLoading, setIsLoading] = useState(true);
  const status = useSyncServerStatus();

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);
      try {
        const results = await send('truelayer-status');
        setConfiguredTrueLayer(results.configured || false);
      } catch {
        setConfiguredTrueLayer(false);
      } finally {
        setIsLoading(false);
      }
    }

    if (status === 'online') {
      void fetch();
    }
  }, [status]);

  return {
    configuredTrueLayer,
    isLoading,
  };
}
