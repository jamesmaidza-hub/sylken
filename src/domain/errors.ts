export class DomainError extends Error {
  constructor(message: string, public code = 'invalid', public status = 400) {
    super(message)
  }
}
