const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));
app.use('/api', require('./routes/portal'));
app.use('/api/pickup', require('./routes/ups-pickup'));
app.use('/api/fedex-pickup', require('./routes/fedex-pickup'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`[Portal API] http://localhost:${PORT}`);
});
