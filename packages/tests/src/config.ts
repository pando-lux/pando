import * as fs from 'fs';
import * as path from 'path';
import type { ProjectConfig } from './types';

const TESTS_DIR = '.pando-tests';
const CONFIG_FILE = 'config.json';
const SCREENSHOTS_DIR = 'screenshots';

export interface StoredConfig {
  project: string;
  gatewayUrl: string;
  apiUrl: string;
  authToken?: string;
}

const DEFAULT_CONFIG: StoredConfig = {
  project: 'default',
  gatewayUrl: '',
  apiUrl: '',
  authToken: undefined,
};

/**
 * Resolve the .pando-tests directory path for a given root.
 */
function testsDir(rootDir: string): string {
  return path.join(rootDir, TESTS_DIR);
}

/**
 * Resolve the config.json path for a given root.
 */
function configPath(rootDir: string): string {
  return path.join(testsDir(rootDir), CONFIG_FILE);
}

/**
 * Load configuration from .pando-tests/config.json, merged with defaults.
 * Returns DEFAULT_CONFIG if no config file exists.
 */
export function loadConfig(rootDir: string): StoredConfig {
  const cfgPath = configPath(rootDir);
  if (!fs.existsSync(cfgPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save configuration to .pando-tests/config.json.
 * Creates the directory if it doesn't exist.
 */
export function saveConfig(rootDir: string, config: StoredConfig): void {
  const dir = testsDir(rootDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath(rootDir), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Initialize the .pando-tests/ directory structure for a project.
 * Creates: .pando-tests/, .pando-tests/config.json, .pando-tests/screenshots/
 */
export function initProject(rootDir: string, config?: Partial<StoredConfig>): StoredConfig {
  const dir = testsDir(rootDir);
  const screenshotsPath = path.join(dir, SCREENSHOTS_DIR);
  const playbooksPath = path.join(dir, 'playbooks');

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(screenshotsPath)) {
    fs.mkdirSync(screenshotsPath, { recursive: true });
  }
  if (!fs.existsSync(playbooksPath)) {
    fs.mkdirSync(playbooksPath, { recursive: true });
  }

  const merged: StoredConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  saveConfig(rootDir, merged);
  return merged;
}

/**
 * Replace {{VAR}} placeholders in a template string using config values.
 * Supported variables: {{PROJECT}}, {{HUB_URL}}, {{API_URL}}, {{AUTH_TOKEN}}
 */
export function resolveVariables(template: string, config: ProjectConfig): string {
  return template
    .replace(/\{\{PROJECT\}\}/g, config.project)
    .replace(/\{\{HUB_URL\}\}/g, config.gatewayUrl)
    .replace(/\{\{API_URL\}\}/g, config.apiUrl)
    .replace(/\{\{AUTH_TOKEN\}\}/g, config.authToken ?? '')
    .replace(/\{\{ROOT_DIR\}\}/g, config.rootDir);
}
