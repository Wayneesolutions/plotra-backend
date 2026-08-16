exports.up = async (knex) => {
  await knex.schema.table('tenants', (table) => {
    table.renameColumn('razorpay_customer_id', 'stripe_customer_id');
  });
  await knex.schema.table('payment_events', (table) => {
    table.renameColumn('razorpay_order_id', 'stripe_session_id');
    table.renameColumn('razorpay_payment_id', 'stripe_payment_intent_id');
  });
};

exports.down = async (knex) => {
  await knex.schema.table('tenants', (table) => {
    table.renameColumn('stripe_customer_id', 'razorpay_customer_id');
  });
  await knex.schema.table('payment_events', (table) => {
    table.renameColumn('stripe_session_id', 'razorpay_order_id');
    table.renameColumn('stripe_payment_intent_id', 'razorpay_payment_id');
  });
};
