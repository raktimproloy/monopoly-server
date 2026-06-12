export const logger = {
  info(message: string, meta?: any) {
    const timestamp = new Date().toISOString();
    console.log(`[\x1b[36m${timestamp}\x1b[0m] [\x1b[32mINFO\x1b[0m]: ${message}`, meta ? JSON.stringify(meta, null, 2) : '');
  },

  warn(message: string, meta?: any) {
    const timestamp = new Date().toISOString();
    console.warn(`[\x1b[36m${timestamp}\x1b[0m] [\x1b[33mWARN\x1b[0m]: ${message}`, meta ? JSON.stringify(meta, null, 2) : '');
  },

  error(message: string, error?: any) {
    const timestamp = new Date().toISOString();
    console.error(
      `[\x1b[36m${timestamp}\x1b[0m] [\x1b[31mERROR\x1b[0m]: ${message}`,
      error instanceof Error ? { message: error.message, stack: error.stack } : error || ''
    );
  },

  game(roomId: string, action: string, playerId: string, description: string) {
    const timestamp = new Date().toISOString();
    console.log(
      `[\x1b[36m${timestamp}\x1b[0m] [\x1b[35mGAME-LOG\x1b[0m] [Room: \x1b[33m${roomId}\x1b[0m] [Player: \x1b[34m${playerId}\x1b[0m]: ${action.toUpperCase()} - ${description}`
    );
  }
};
