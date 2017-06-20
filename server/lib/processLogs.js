const SplunkLogger = require('splunk-logging').Logger;
const loggingTools = require('auth0-log-extension-tools');

const config = require('./config');
const logger = require('./logger');

module.exports = (storage) =>
  (req, res, next) => {
    const wtBody = (req.webtaskContext && req.webtaskContext.body) || req.body || {};
    const wtHead = (req.webtaskContext && req.webtaskContext.headers) || {};
    const isCron = (wtBody.schedule && wtBody.state === 'active') || (wtHead.referer === 'https://manage.auth0.com/' && wtHead['if-none-match']);

    if (!isCron) {
      return next();
    }

    const Logger = new SplunkLogger({
      token: config('SPLUNK_TOKEN'),
      url: config('SPLUNK_URL'),
      port: config('SPLUNK_COLLECTOR_PORT') || 8088,
      path: config('SPLUNK_COLLECTOR_PATH') || '/services/collector/event/1.0',
      maxBatchCount: 0 // Manually flush events
    });

    Logger.error = function (err, context) {
      // Handle errors here
      logger.error('error', err, 'context', context);
    };

    const onLogsReceived = (logs, cb) => {
      if (!logs || !logs.length) {
        return cb();
      }

      logs.forEach(function (entry) {
        Logger.send({ message: entry });
      });

      logger.info(`Sending ${logs.length} logs to Splunk...`);

      Logger.flush(function(error, response, body) {
        logger.info('Splunk response', body);
        if (error) {
          return cb({ error: error, message: 'Error sending logs to Splunk' });
        }

        logger.info('Upload complete.');
        return cb();
      });
    };

    const slack = new loggingTools.reporters.SlackReporter({
      hook: config('SLACK_INCOMING_WEBHOOK_URL'),
      username: 'auth0-logs-to-splunk',
      title: 'Logs To Splunk'
    });

    const options = {
      domain: config('AUTH0_DOMAIN'),
      clientId: config('AUTH0_CLIENT_ID'),
      clientSecret: config('AUTH0_CLIENT_SECRET'),
      batchSize: config('BATCH_SIZE'),
      startFrom: config('START_FROM'),
      logTypes: config('LOG_TYPES'),
      logLevel: config('LOG_LEVEL')
    };

    const auth0logger = new loggingTools.LogsProcessor(storage, options);

    const sendDailyReport = () => {
      const reportTime = config('DAILY_REPORT_TIME') || '16:00';

      if (!reportTime || !/\d:\d/.test(reportTime)) {
        return null;
      }

      const current = new Date();
      const hour = current.getHours();
      const minute = current.getMinutes();
      const trigger = reportTime.split(':');
      const triggerHour = parseInt(trigger[0]);
      const triggerMinute = parseInt(trigger[1]);

      if (hour === triggerHour && (minute >= triggerMinute && minute < triggerMinute + 5)) {
        const end = current.getTime();
        const start = end - 86400000;
        auth0logger.getReport(start, end)
          .then(report => slack.send(report, report.checkpoint));
      }
    };

    return auth0logger
      .run(onLogsReceived)
      .then(result => {
        if (result && result.status && result.status.error) {
          slack.send(result.status, result.checkpoint);
        } else if (config('SLACK_SEND_SUCCESS') === true || config('SLACK_SEND_SUCCESS') === 'true') {
          slack.send(result.status, result.checkpoint);
        }
        sendDailyReport();
        res.json(result);
      })
      .catch(err => {
        slack.send({ error: err, logsProcessed: 0 }, null);
        next(err);
      });
  };
