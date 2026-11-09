declare global {
  namespace Express {
    interface Request {
      /** Có giá trị sau khi qua middleware requireAuth. */
      userId?: string;
    }
  }
}

export {};
