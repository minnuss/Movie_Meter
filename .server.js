require('dotenv').config();

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OMDB_API_KEY = process.env.OMDB_API_KEY;

// Replace hardcoded API keys with variables
const apiKey = TMDB_API_KEY || '88fc2de7fb7bef9f3493e59b42ccdd13';
const omdbApiKey = OMDB_API_KEY || 'e9fa56bf';