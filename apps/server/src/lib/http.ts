import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${name} is required`);
  }
  return value.trim();
}

export function requireNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${name} must be a number`);
  }
  return parsed;
}
