import pg from 'pg';
import { env } from '@shop/config';

export const pool = new pg.Pool({ connectionString: env('DATABASE_URL') });
