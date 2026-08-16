require('dotenv').config();
const app = require('./app');
const knex = require('knex')(require('../knexfile')[process.env.NODE_ENV || 'development']);

const PORT = process.env.PORT || 3001;

// Bind the Knex DB client to the Express app
app.set('db', knex);

app.listen(PORT, () => {
  console.log(`[Server] Property Visual Explorer API running on port ${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
});
