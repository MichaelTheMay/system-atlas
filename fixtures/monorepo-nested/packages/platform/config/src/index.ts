export const ORDER_QUEUE = 'order-jobs';

export const env = (name: string): string => process.env[name] ?? '';
