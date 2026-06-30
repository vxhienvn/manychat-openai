const { app, startBackgroundJobs } = require('./src/app');

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
    startBackgroundJobs();
});
