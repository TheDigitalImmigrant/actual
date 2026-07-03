// TrueLayer API response types

export type TrueLayerProvider = {
  provider_id: string;
  display_name: string;
  logo_url?: string;
  country?: string;
};

// Normalized type for client-side account selection
export type SyncServerTrueLayerAccount = {
  account_id: string;
  name: string;
  official_name: string;
  institution: string;
  currency: string;
  balance: number;
  type: 'account' | 'card';
  iban?: string;
  mask?: string;
  requisitionId: string;
};
