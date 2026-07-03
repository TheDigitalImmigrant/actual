import { getDefaultImportPending } from './bank-sync';

describe('getDefaultImportPending', () => {
  it('defaults to not importing pending for trueLayer accounts', () => {
    expect(getDefaultImportPending('trueLayer')).toBe(false);
  });

  it('defaults to importing pending for other providers', () => {
    expect(getDefaultImportPending('goCardless')).toBe(true);
    expect(getDefaultImportPending('simpleFin')).toBe(true);
    expect(getDefaultImportPending('enableBanking')).toBe(true);
  });

  it('defaults to importing pending when the sync source is unknown', () => {
    expect(getDefaultImportPending(null)).toBe(true);
    expect(getDefaultImportPending(undefined)).toBe(true);
  });
});
