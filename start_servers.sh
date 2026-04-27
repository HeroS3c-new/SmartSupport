#!/bin/bash
echo "Starting servers..."
node index.js &
python prediction_server.py &
mkdocs serve &
echo "Servers started in the background."
