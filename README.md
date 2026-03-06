# 🌍 Website Carbon Audit

A production-ready web application that analyzes the carbon footprint of any website. It performs a full-site audit by discovering pages via sitemaps, measuring real-world data transfer using a headless browser (Puppeteer), and calculating emissions using the Sustainable Web Design model.

## ✨ Features

- **Real-Time Scanning**: Discovers pages via `sitemap_index.xml`, `sitemap.xml`, or `robots.txt`.
- **True Measurement**: Uses a headless Chromium browser to load pages and capture the exact transfer size of all resources (images, scripts, fonts, third-party APIs). No estimates or multipliers.
- **Green Hosting Check**: Verifies if the domain is hosted on green energy via The Green Web Foundation API.
- **One Overall Score**: Aggregates data from all scanned pages into a single, confident sustainability grade (A+ to F).
- **Comprehensive Reports**:
  - Annual environmental impact (trees, energy, driving distance).
  - Actionable recommendations based on scan data.
- **Export**: Download results as CSV or copy summaries.

## 🛠️ Tech Stack

- **Backend**: Node.js, Express
- **Browser Automation**: Puppeteer (Headless Chrome)
- **Frontend**: Vanilla HTML/CSS/JS (Single file, no build step required)
- **APIs**: Website Carbon API, The Green Web Foundation

## 🚀 Installation & Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```
   *Note: This will download a local version of Chromium (~170MB) for Puppeteer.*

2. **Run the Server**
   ```bash
   npm start
   ```
   The server will start on port 3000.

3. **Access the App**
   Open your browser and navigate to:
   `http://localhost:3000`

## 🐳 Docker / Deployment Notes

If deploying to a Linux environment (like Docker, Heroku, or Render), you may need to install system dependencies for Chromium.

The application is configured with the following Puppeteer launch flags for stability in containerized environments:
- `--no-sandbox`
- `--disable-setuid-sandbox`
- `--disable-dev-shm-usage`

## 📊 Methodology (SWDM v4)

1. **Discovery**: The app parses XML sitemaps (handling GZIP and nested indices) to find up to 50 pages.
2. **Measurement**: Each page is visited by Puppeteer. We intercept every network response and sum the `encodedDataLength` (compressed wire-transfer size) to get the **Total Transfer Bytes**.
3. **Calculation**: This raw byte count is sent to the Website Carbon API (`/data` endpoint), which applies the Sustainable Web Design v4 model to calculate CO₂e.
4. **Rating**: The overall site grade is the **MODE** (most frequent) of the per-page ratings. If there is a tie, the worse (lower) grade is used. This ensures the grade reflects the typical page on the site.

---
*Powered by websitecarbon.com API & The Green Web Foundation*
