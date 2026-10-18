const test = require('node:test');
const assert = require('node:assert');
const { buildAgentWelcomeMessage } = require('../src/controllers/agentSignupController');

test('approval welcome gives the first three steps, with login only when given', () => {
  const hi = buildAgentWelcomeMessage({ name: 'Rajesh', lang: 'hi', credentials: { email: 'agent.91@x', password: 'Welcome1!' } });
  assert.match(hi, /swagat hai, Rajesh ji/);
  assert.match(hi, /1\. Property ki details/);
  assert.match(hi, /exact location/);
  assert.match(hi, /"haan"/);
  assert.match(hi, /Welcome1!/);
  const en = buildAgentWelcomeMessage({ name: 'Simran', lang: 'en' });
  assert.match(en, /Welcome to Plotraa, Simran/);
  assert.doesNotMatch(en, /Dashboard login/);
});
