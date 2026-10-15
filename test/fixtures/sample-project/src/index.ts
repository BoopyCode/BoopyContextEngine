import express, { Request, Response } from 'express';
import { OrderService } from './services/orderService';
import { UserService } from './services/userService';
import { formatMoney } from './utils/money';

/**
 * HTTP entry point of the sample shop API.
 */
export function createServer(): express.Express {
  const app = express();
  const orderService = new OrderService();
  const userService = new UserService();

  app.get('/orders/:id', async (req: Request, res: Response) => {
    const order = await orderService.findById(req.params.id);
    res.json({ ...order, total: formatMoney(order.totalCents) });
  });

  app.post('/orders', async (req: Request, res: Response) => {
    const order = await orderService.create(req.body);
    res.status(201).json(order);
  });

  app.get('/users/:id', async (req: Request, res: Response) => {
    res.json(await userService.findById(req.params.id));
  });

  return app;
}

const server = createServer();
server.listen(3000);
