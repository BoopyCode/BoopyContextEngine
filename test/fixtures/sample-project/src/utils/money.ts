/** Formats integer cents as a human readable price. */
export function formatMoney(cents: number, currency = 'EUR'): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function parseMoney(value: string): number {
  return Math.round(Number.parseFloat(value.replace(/[^0-9.,]/g, '').replace(',', '.')) * 100);
}
