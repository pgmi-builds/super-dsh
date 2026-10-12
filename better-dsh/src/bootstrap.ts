/** Module-qualified initialization survives OMP %reset without leaking imports. */
export const KERNEL_BOOTSTRAP = `__import__('better_support').initialize(globals())`
