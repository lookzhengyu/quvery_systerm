import nodemailer from 'nodemailer';

export function createNotificationService({
  smtpHost,
  smtpPort,
  smtpSecure,
  smtpUser,
  smtpPassword,
  gmailUser,
  gmailAppPassword,
  fromAddress,
  createLog,
  updateLog,
}) {
  const hasSmtpConfig =
    typeof smtpHost === 'string' &&
    smtpHost.length > 0 &&
    typeof smtpUser === 'string' &&
    smtpUser.length > 0 &&
    typeof smtpPassword === 'string' &&
    smtpPassword.length > 0;
  const hasGmailConfig =
    typeof gmailUser === 'string' &&
    gmailUser.length > 0 &&
    typeof gmailAppPassword === 'string' &&
    gmailAppPassword.length > 0;
  const hasAnySmtpValue =
    (typeof smtpHost === 'string' && smtpHost.length > 0) ||
    (typeof smtpUser === 'string' && smtpUser.length > 0) ||
    (typeof smtpPassword === 'string' && smtpPassword.length > 0);
  const hasAnyGmailValue =
    (typeof gmailUser === 'string' && gmailUser.length > 0) ||
    (typeof gmailAppPassword === 'string' && gmailAppPassword.length > 0);
  const isConfigured = hasSmtpConfig || hasGmailConfig;
  const provider = hasSmtpConfig ? 'smtp' : hasGmailConfig ? 'gmail' : 'disabled';
  const normalizedFromAddress =
    typeof fromAddress === 'string' && fromAddress.trim().length > 0 ? fromAddress.trim() : null;

  const transporter = isConfigured
    ? hasSmtpConfig
      ? nodemailer.createTransport({
          host: smtpHost,
          port: Number.parseInt(String(smtpPort ?? '587'), 10) || 587,
          secure: String(smtpSecure ?? '').toLowerCase() === 'true',
          auth: {
            user: smtpUser,
            pass: smtpPassword,
          },
        })
      : nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: gmailUser,
            pass: gmailAppPassword,
          },
      })
    : null;

  function getPublicConfig() {
    let missingEnv = [];
    let preferredProvider = provider;

    if (!isConfigured) {
      if (hasAnySmtpValue) {
        preferredProvider = 'smtp';
        if (!(typeof smtpHost === 'string' && smtpHost.length > 0)) {
          missingEnv.push('QUEUE_SMTP_HOST');
        }
        if (!(typeof smtpUser === 'string' && smtpUser.length > 0)) {
          missingEnv.push('QUEUE_SMTP_USER');
        }
        if (!(typeof smtpPassword === 'string' && smtpPassword.length > 0)) {
          missingEnv.push('QUEUE_SMTP_PASSWORD');
        }
      } else if (hasAnyGmailValue) {
        preferredProvider = 'gmail';
        if (!(typeof gmailUser === 'string' && gmailUser.length > 0)) {
          missingEnv.push('QUEUE_GMAIL_USER');
        }
        if (!(typeof gmailAppPassword === 'string' && gmailAppPassword.length > 0)) {
          missingEnv.push('QUEUE_GMAIL_APP_PASSWORD');
        }
      } else {
        preferredProvider = 'disabled';
        missingEnv = ['QUEUE_SMTP_HOST', 'QUEUE_SMTP_USER', 'QUEUE_SMTP_PASSWORD'];
      }
    }

    return {
      provider: preferredProvider,
      deliveryEnabled: isConfigured,
      fromAddress: normalizedFromAddress ?? smtpUser ?? gmailUser ?? null,
      config: {
        configured: isConfigured,
        missingEnv,
      },
    };
  }

  async function sendEmail({
    storeId,
    customerId,
    recipient,
    subject,
    body,
    eventType,
    metadata = {},
    missingRecipientMessage = 'Recipient email address is missing.',
  }) {
    const normalizedRecipient = recipient?.trim().toLowerCase() ?? '';
    const logId = await createLog({
      storeId,
      customerId,
      channel: 'email',
      recipient: normalizedRecipient || '(missing)',
      eventType,
      subject,
      body,
      status: 'pending',
      provider,
      createdAt: new Date().toISOString(),
      metadata,
    });

    if (!normalizedRecipient) {
      await updateLog(logId, {
        status: 'skipped',
        errorMessage: missingRecipientMessage,
      });
      return { ok: false, reason: 'missing-recipient' };
    }

    if (!transporter) {
      await updateLog(logId, {
        status: 'skipped',
        errorMessage: 'Email delivery is not configured on the backend.',
      });
      return { ok: false, reason: 'provider-disabled' };
    }

    try {
      await transporter.sendMail({
        from: fromAddress || smtpUser || gmailUser,
        to: normalizedRecipient,
        subject,
        text: body,
      });

      await updateLog(logId, {
        status: 'sent',
        sentAt: new Date().toISOString(),
      });
      return { ok: true };
    } catch (error) {
      await updateLog(logId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown email send failure',
      });
      return { ok: false, reason: 'send-failed' };
    }
  }

  async function sendQueueCalledEmail({ storeId, storeName, customer, table }) {
    const subject = `${storeName}: your table is ready`;
    const body = [
      `Hello,`,
      '',
      `Your QueueFlow table is ready at ${storeName}.`,
      table ? `Reserved table: ${table.name}` : 'Please proceed to the host stand now.',
      `Queue number: #${customer.queueNumber}`,
      `Party size: ${customer.partySize}`,
      '',
      'Please confirm your arrival from the queue page before your hold expires.',
    ].join('\n');

    return sendEmail({
      storeId,
      customerId: customer.id,
      recipient: customer.email,
      eventType: 'customer_called',
      subject,
      body,
      metadata: {
        queueNumber: customer.queueNumber,
        tableName: table?.name ?? '',
      },
      missingRecipientMessage: 'Customer did not provide an email address.',
    });
  }

  async function sendTestEmail({ storeId, storeName, recipient }) {
    const subject = `${storeName}: notification delivery test`;
    const body = [
      `Hello,`,
      '',
      `This is a QueueFlow notification test for ${storeName}.`,
      'If you received this email, customer queue email delivery is working.',
      '',
      `Store ID: ${storeId}`,
      `Sent at: ${new Date().toISOString()}`,
    ].join('\n');

    return sendEmail({
      storeId,
      customerId: undefined,
      recipient,
      eventType: 'test_email',
      subject,
      body,
      metadata: {
        type: 'merchant-test-email',
      },
      missingRecipientMessage: 'Merchant test email requires a recipient address.',
    });
  }

  return {
    sendQueueCalledEmail,
    sendTestEmail,
    isConfigured,
    provider,
    getPublicConfig,
  };
}
