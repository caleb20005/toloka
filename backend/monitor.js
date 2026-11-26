const fs = require('fs');
try {
    fs.writeFileSync('monitor_test.txt', 'Hello from Node');
    console.log('File written successfully');
} catch (e) {
    console.error('Error writing file:', e);
}
