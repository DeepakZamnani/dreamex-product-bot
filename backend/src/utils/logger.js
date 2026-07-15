const winston = require('winston');

const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const logFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({timestamp, level, module, message, ...meta}) => {
      return `${timestamp}::[${level.toUpperCase()}]::(${module})::${message}::${JSON.stringify(meta)}`;
    })
);

const logger = winston.createLogger({
  levels: logLevels,
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.colorize({all: true})
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error'
    }),
    new winston.transports.File({
      filename: 'logs/combined.log'
    })
  ]
});

module.exports = logger;