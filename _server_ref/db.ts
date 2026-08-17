import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

let sqlInstance: any = null;

export const sql = (strings: any, ...values: any) => {
  if (!sqlInstance) {
    if (!process.env.DATABASE_URL) {
      console.warn('DATABASE_URL environment variable is not set. Database features will be disabled.');
      // Return a mock or throw a clear error when called
      throw new Error('Database is not configured. Please set DATABASE_URL in Secrets.');
    }
    sqlInstance = neon(process.env.DATABASE_URL);
  }
  return sqlInstance(strings, ...values);
};
