function loadEnvVars(context, _events, next) {
  context.vars.storeId = process.env.QUEUEFLOW_LOAD_STORE_ID;
  context.vars.merchantToken = process.env.QUEUEFLOW_LOAD_MERCHANT_TOKEN;
  return next();
}

module.exports = {
  loadEnvVars,
};
