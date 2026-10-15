import { NewOrder, Order } from '../models/order';
import { formatMoney } from '../utils/money';

/**
 * Business logic for orders: pricing, persistence and refunds.
 */
export class OrderService {
  private readonly orders = new Map<string, Order>();

  async findById(id: string): Promise<Order> {
    const order = this.orders.get(id);
    if (!order) {
      throw new Error(`Order ${id} not found`);
    }
    return order;
  }

  async create(input: NewOrder): Promise<Order> {
    const totalCents = input.items.reduce((total, item) => total + item.quantity * item.unitPriceCents, 0);
    const order: Order = {
      id: `ord_${this.orders.size + 1}`,
      userId: input.userId,
      totalCents,
      status: 'pending'
    };
    this.orders.set(order.id, order);
    return order;
  }

  /** Refunding an order is irreversible, so it is guarded by the status check. */
  async refund(id: string): Promise<Order> {
    const order = await this.findById(id);
    if (order.status !== 'paid') {
      throw new Error(`Order ${id} cannot be refunded from status ${order.status}`);
    }
    return { ...order, status: 'refunded' };
  }

  describe(order: Order): string {
    return `Order ${order.id} for ${order.userId}: ${formatMoney(order.totalCents)}`;
  }
}
