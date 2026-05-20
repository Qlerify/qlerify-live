import { DomainError } from "../errors.js";

export function check(violations: string[]) {
  if (violations.length > 0) {
    throw new DomainError(
      violations.length === 1 ? violations[0]! : `${violations.length} invariant violations`,
      violations,
    );
  }
}

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

export function requireNonNegativeInt(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new DomainError(`${name} must be a non-negative integer`);
  }
}

export function requireOneOf<T extends string>(name: string, value: unknown, allowed: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DomainError(`${name} must be one of: ${allowed.join(", ")}`);
  }
}
