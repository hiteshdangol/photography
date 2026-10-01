import type { mongo } from 'mongoose';

/**
 * Mongoose's own filter type is declared inside `declare module 'mongoose'` but
 * never re-exported, so it cannot be imported by name. The MongoDB driver's
 * `Filter` is the type mongoose accepts underneath and does allow `$expr` and the
 * other aggregation-style root operators.
 */
export type Filter<T> = mongo.Filter<T>;
