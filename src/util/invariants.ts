import { DomainError } from "../errors.js";

export function requireString(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(`${name} is required`);
  }
}

export function requirePositiveInt(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new DomainError(`${name} must be a positive integer`);
  }
}
