require('dotenv').config();   // FIRST LINE
const app = require('./src/app.js');

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
