import Stripe from 'stripe';

const STRIPE_API_VERSION = '2026-02-25.clover';

function parseAmount(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeCurrency(value) {
  if (typeof value !== 'string') {
    return 'usd';
  }

  const normalized = value.trim().toLowerCase();
  return /^[a-z]{3}$/.test(normalized) ? normalized : 'usd';
}

function resolvePlanCatalog() {
  const currency = normalizeCurrency(process.env.QUEUEFLOW_STRIPE_CURRENCY);

  return {
    starter: {
      planCode: 'starter',
      label: 'Starter',
      description: 'QueueFlow Starter monthly subscription',
      amount: parseAmount(process.env.QUEUEFLOW_STRIPE_STARTER_MONTHLY_AMOUNT, 4900),
      currency,
      interval: 'month',
    },
    growth: {
      planCode: 'growth',
      label: 'Growth',
      description: 'QueueFlow Growth monthly subscription',
      amount: parseAmount(process.env.QUEUEFLOW_STRIPE_GROWTH_MONTHLY_AMOUNT, 9900),
      currency,
      interval: 'month',
    },
    scale: {
      planCode: 'scale',
      label: 'Scale',
      description: 'QueueFlow Scale monthly subscription',
      amount: parseAmount(process.env.QUEUEFLOW_STRIPE_SCALE_MONTHLY_AMOUNT, 19900),
      currency,
      interval: 'month',
    },
  };
}

function buildPublicPlanCatalog(planCatalog) {
  return Object.fromEntries(
    Object.entries(planCatalog).map(([planCode, plan]) => [
      planCode,
      {
        planCode,
        label: plan.label,
        description: plan.description,
        amount: plan.amount,
        currency: plan.currency,
        interval: plan.interval,
      },
    ])
  );
}

function mapSubscriptionStatus(status) {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'past_due';
    default:
      return 'inactive';
  }
}

function isoFromUnix(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

function assertStoreId(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toUpperCase() : '';
}

function buildConfigStatus({ hasSecretKey, hasWebhookSecret }) {
  const missingEnv = [];

  if (!hasSecretKey) {
    missingEnv.push('STRIPE_SECRET_KEY');
  }

  if (!hasWebhookSecret) {
    missingEnv.push('STRIPE_WEBHOOK_SECRET');
  }

  return {
    configured: missingEnv.length === 0,
    missingEnv,
  };
}

export function createBillingService({
  secretKey = process.env.STRIPE_SECRET_KEY ?? '',
  webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '',
} = {}) {
  const planCatalog = resolvePlanCatalog();
  const publicPlans = buildPublicPlanCatalog(planCatalog);
  const hasSecretKey = secretKey.trim().length > 0;
  const hasWebhookSecret = webhookSecret.trim().length > 0;
  const configured = hasSecretKey && hasWebhookSecret;
  const configStatus = buildConfigStatus({
    hasSecretKey,
    hasWebhookSecret,
  });

  if (!configured) {
    return {
      provider: hasSecretKey ? 'stripe' : 'none',
      isConfigured: false,
      getPublicConfig() {
        return {
          provider: hasSecretKey ? 'stripe' : 'none',
          checkoutEnabled: false,
          portalEnabled: false,
          plans: publicPlans,
          config: configStatus,
        };
      },
      async createCheckoutSession() {
        throw new Error('Stripe billing is not configured yet.');
      },
      async createPortalSession() {
        throw new Error('Stripe billing is not configured yet.');
      },
      constructWebhookEvent() {
        throw new Error('Stripe billing is not configured yet.');
      },
      async resolveSubscriptionSnapshot() {
        throw new Error('Stripe billing is not configured yet.');
      },
    };
  }

  const stripe = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
  });

  async function ensureCustomer({ existingCustomerId, profile }) {
    const customerPayload = {
      email: profile.ownerEmail,
      name: profile.storeName,
      phone: profile.contactPhone || undefined,
      metadata: {
        storeId: profile.storeId,
        planCode: profile.planCode,
      },
    };

    if (typeof existingCustomerId === 'string' && existingCustomerId.length > 0) {
      await stripe.customers.update(existingCustomerId, customerPayload);
      return existingCustomerId;
    }

    const customer = await stripe.customers.create(customerPayload);
    return customer.id;
  }

  return {
    provider: 'stripe',
    isConfigured: true,
    getPublicConfig() {
      return {
        provider: 'stripe',
        checkoutEnabled: true,
        portalEnabled: true,
        plans: publicPlans,
        config: configStatus,
      };
    },
    async createCheckoutSession({
      existingCustomerId,
      profile,
      requestedPlanCode,
      successUrl,
      cancelUrl,
    }) {
      const plan = planCatalog[requestedPlanCode] ?? planCatalog[profile.planCode] ?? planCatalog.growth;
      const customerId = await ensureCustomer({
        existingCustomerId,
        profile: {
          ...profile,
          planCode: plan.planCode,
        },
      });

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: profile.storeId,
        allow_promotion_codes: true,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: plan.currency,
              unit_amount: plan.amount,
              recurring: {
                interval: plan.interval,
              },
              product_data: {
                name: `QueueFlow ${plan.label}`,
                description: plan.description,
                metadata: {
                  storeId: profile.storeId,
                  planCode: plan.planCode,
                },
              },
            },
          },
        ],
        metadata: {
          storeId: profile.storeId,
          planCode: plan.planCode,
          billingCycle: 'monthly',
        },
        subscription_data: {
          metadata: {
            storeId: profile.storeId,
            planCode: plan.planCode,
            billingCycle: 'monthly',
          },
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
      });

      if (!session.url) {
        throw new Error('Stripe did not return a checkout URL.');
      }

      return {
        customerId,
        sessionId: session.id,
        url: session.url,
      };
    },
    async createPortalSession({ customerId, returnUrl }) {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });

      return {
        url: session.url,
      };
    },
    constructWebhookEvent(rawBody, signature) {
      if (!webhookSecret) {
        throw new Error('STRIPE_WEBHOOK_SECRET is not configured.');
      }

      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },
    async resolveSubscriptionSnapshot({ subscriptionId, customerId, fallbackStoreId }) {
      const subscription = subscriptionId
        ? await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ['items.data.price', 'customer'],
          })
        : null;
      const resolvedCustomer =
        typeof subscription?.customer === 'string'
          ? await stripe.customers.retrieve(subscription.customer)
          : subscription?.customer ??
            (customerId ? await stripe.customers.retrieve(customerId) : null);
      const item = subscription?.items?.data?.[0] ?? null;
      const metadataStoreId =
        assertStoreId(subscription?.metadata?.storeId) ||
        (resolvedCustomer && !resolvedCustomer.deleted
          ? assertStoreId(resolvedCustomer.metadata?.storeId)
          : '') ||
        assertStoreId(fallbackStoreId);

      return {
        storeId: metadataStoreId,
        planCode:
          subscription?.metadata?.planCode ??
          (resolvedCustomer && !resolvedCustomer.deleted
            ? resolvedCustomer.metadata?.planCode
            : null) ??
          null,
        subscriptionStatus: subscription ? mapSubscriptionStatus(subscription.status) : 'inactive',
        billingCycle: item?.price?.recurring?.interval ?? 'monthly',
        trialEndsAt: isoFromUnix(subscription?.trial_end),
        billingRecord: {
          stripeCustomerId:
            resolvedCustomer && !resolvedCustomer.deleted ? resolvedCustomer.id : customerId ?? null,
          stripeSubscriptionId: subscription?.id ?? null,
          stripePriceId: item?.price?.id ?? null,
          currentPeriodEnd: isoFromUnix(subscription?.current_period_end),
          cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
          stripeCheckoutSessionId: null,
          lastInvoiceStatus: null,
        },
      };
    },
  };
}
