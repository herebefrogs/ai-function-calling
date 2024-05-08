class ValidationError extends Error {
  constructor(errors) {
    super();
    this.name = 'ValidationError';
    this.errors = errors;
  }

  get message() {
    return this.errors;
  }
}

export { ValidationError };