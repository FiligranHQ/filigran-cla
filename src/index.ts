import express, { Request, Response, NextFunction } from 'express';
import { config, validateConfig } from './config';
import { initDatabase, closeDatabase } from './services/database';
import { logger } from './utils/logger';
import githubRoutes from './routes/github';
import concordRoutes from './routes/concord';

const app = express();

// Trust proxy for proper IP detection behind load balancers
app.set('trust proxy', 1);

// JSON body parser
app.use(express.json());

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.debug('Request completed', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
    });
  });
  next();
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'filigran-cla',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Mount routes
app.use('/github', githubRoutes);
app.use('/concord', concordRoutes);

// API info endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    service: 'Filigran CLA Bot',
    version: '1.0.0',
    description: 'Contributor License Agreement management for Filigran open source projects',
    endpoints: {
      health: '/health',
      github: {
        webhook: '/github/webhook',
      },
      concord: {
        webhook: '/concord/webhook',
        health: '/concord/health',
      },
    },
    documentation: 'https://github.com/FiligranHQ/filigran-cla',
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
  });
});

// Error handler
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    error: 'Internal Server Error',
    message: config.nodeEnv === 'development' ? err.message : 'An unexpected error occurred',
  });
});

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...');
  closeDatabase();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the server
async function start() {
  try {
    // Validate configuration
    validateConfig();
    logger.info('Configuration validated');

    // Initialize database
    initDatabase();

    // Start listening
    app.listen(config.port, () => {
      logger.info(`Filigran CLA Bot started`, {
        port: config.port,
        env: config.nodeEnv,
        publicUrl: config.publicUrl,
      });
      
      logger.info('Webhook endpoints:', {
        github: `${config.publicUrl}/github/webhook`,
        concord: `${config.publicUrl}/concord/webhook`,
      });
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

start();
