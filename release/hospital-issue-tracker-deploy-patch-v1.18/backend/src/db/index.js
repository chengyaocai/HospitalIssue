import { config } from '../config.js';
import { createDevRepo } from './devRepo.js';
import { createMssqlRepo } from './mssqlRepo.js';

let repo;

export async function getRepo() {
  if (repo) return repo;
  if (config.dbDriver === 'dev') {
    repo = createDevRepo(config.devDbPath);
  } else {
    repo = createMssqlRepo(config.mssql);
  }
  await repo.init();
  return repo;
}
