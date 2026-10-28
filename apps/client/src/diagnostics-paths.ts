import {homedir} from 'node:os';
import {join} from 'node:path';

export const diagnosticDataDir=process.env.DESKBEACON_DATA_DIR??join(homedir(),'.deskbeacon');
export const logsDir=join(diagnosticDataDir,'logs');
