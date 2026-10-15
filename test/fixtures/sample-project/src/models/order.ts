export interface Order {
  id: string;
  userId: string;
  totalCents: number;
  status: 'pending' | 'paid' | 'refunded';
}

export interface NewOrder {
  userId: string;
  items: { sku: string; quantity: number; unitPriceCents: number }[];
}
