import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseDotEnv } from '../../config/dotenv.js';
import * as fs from 'node:fs';

vi.mock('node:fs');

const mockReadFileSync = vi.mocked(fs.readFileSync);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseDotEnv', () => {
  it('parses simple KEY=value pairs', () => {
    mockReadFileSync.mockReturnValue('FOO=bar\nBAZ=qux');
    expect(parseDotEnv('.env')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips double quotes from values', () => {
    mockReadFileSync.mockReturnValue('API_KEY="sk-test123"');
    expect(parseDotEnv('.env')).toEqual({ API_KEY: 'sk-test123' });
  });

  it('strips single quotes from values', () => {
    mockReadFileSync.mockReturnValue("SECRET='my-secret'");
    expect(parseDotEnv('.env')).toEqual({ SECRET: 'my-secret' });
  });

  it('does not strip mismatched quotes', () => {
    mockReadFileSync.mockReturnValue('KEY="value\'');
    expect(parseDotEnv('.env')).toEqual({ KEY: '"value\'' });
  });

  it('does not strip quotes that are not surrounding', () => {
    mockReadFileSync.mockReturnValue('KEY=say "hello"');
    expect(parseDotEnv('.env')).toEqual({ KEY: 'say "hello"' });
  });

  it('preserves value that is just quotes with content', () => {
    mockReadFileSync.mockReturnValue('KEY=""');
    // Empty string after stripping -- skipped
    expect(parseDotEnv('.env')).toEqual({});
  });

  it('skips comment lines', () => {
    mockReadFileSync.mockReturnValue('# comment\nKEY=val');
    expect(parseDotEnv('.env')).toEqual({ KEY: 'val' });
  });

  it('skips empty values', () => {
    mockReadFileSync.mockReturnValue('KEY=\nOTHER=val');
    expect(parseDotEnv('.env')).toEqual({ OTHER: 'val' });
  });

  it('skips lines without =', () => {
    mockReadFileSync.mockReturnValue('NOEQUALS\nKEY=val');
    expect(parseDotEnv('.env')).toEqual({ KEY: 'val' });
  });

  it('handles values with = in them', () => {
    mockReadFileSync.mockReturnValue('KEY=a=b=c');
    expect(parseDotEnv('.env')).toEqual({ KEY: 'a=b=c' });
  });

  it('trims whitespace around keys and values', () => {
    mockReadFileSync.mockReturnValue('  KEY  =  value  ');
    expect(parseDotEnv('.env')).toEqual({ KEY: 'value' });
  });

  it('handles \\r\\n line endings', () => {
    mockReadFileSync.mockReturnValue('A=1\r\nB=2\r\n');
    expect(parseDotEnv('.env')).toEqual({ A: '1', B: '2' });
  });

  it('returns empty object when file does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(parseDotEnv('.env')).toEqual({});
  });
});
