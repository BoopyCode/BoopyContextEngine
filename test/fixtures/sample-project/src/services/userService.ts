export interface User {
  id: string;
  email: string;
  displayName: string;
}

/**
 * Minimal user lookup used by the API layer.
 */
export class UserService {
  private readonly users = new Map<string, User>();

  async findById(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async findByEmail(email: string): Promise<User | undefined> {
    return [...this.users.values()].find((user) => user.email === email);
  }

  register(user: User): User {
    this.users.set(user.id, user);
    return user;
  }
}
