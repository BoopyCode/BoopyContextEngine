import { describe, expect, it } from 'vitest';
import { OrderService } from '../src/services/orderService';
import { formatMoney } from '../src/utils/money';

describe('OrderService', () => {
  it('creates an order and computes the total', async () => {
    const service = new OrderService();
    const order = await service.create({ userId: 'u1', items: [{ sku: 'sku-1', quantity: 2, unitPriceCents: 500 }] });
    expect(order.totalCents).toBe(1000);
    expect(formatMoney(order.totalCents)).toBe('10.00 EUR');
  });

  it('refuses to refund an order that is not paid', async () => {
    const service = new OrderService();
    const order = await service.create({ userId: 'u1', items: [] });
    await expect(service.refund(order.id)).rejects.toThrow(/cannot be refunded/);
  });
});
