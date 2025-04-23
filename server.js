require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const app = express();
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 3600 });

app.use(express.static('public'));

// Rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use(limiter);

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// Separate IMDb scraper function
async function fetchIMDbRating(query) {
    console.log(`Fetching IMDb rating for: ${query}`);
    
    try {
        const apiKey = process.env.TMDB_API_KEY;
        const tmdbSearchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(query)}`;
        const { data } = await axios.get(tmdbSearchUrl);
        
        if (data.results.length === 0) return 'N/A';
        
        const movieId = data.results[0].id;
        const detailsUrl = `https://api.themoviedb.org/3/movie/${movieId}?api_key=${apiKey}&append_to_response=external_ids`;
        const { data: movieData } = await axios.get(detailsUrl);
        
        if (!movieData.external_ids?.imdb_id) return 'N/A';
        
        const imdbId = movieData.external_ids.imdb_id;
        const imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
        
        console.log(`Fetching IMDb page: ${imdbUrl}`);
        
        const { data: imdbHtml } = await axios.get(imdbUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/'
            }
        });
        
        const $ = cheerio.load(imdbHtml);
        
        let rating = $('.sc-d541859f-1.imUuxf').first().text().trim();
        if (rating && !isNaN(parseFloat(rating))) {
            console.log(`IMDb rating (from specific class): ${rating}`);
            return rating;
        }
        
        rating = $('[data-testid="hero-rating-bar__aggregate-rating__score"] span').first().text().trim();
        if (rating && !isNaN(parseFloat(rating))) {
            console.log(`IMDb rating (from hero rating bar): ${rating}`);
            return rating;
        }
        
        rating = $('.ipc-button__text span').first().text().trim();
        if (rating && !isNaN(parseFloat(rating)) && rating.length < 5) {
            console.log(`IMDb rating (from button text): ${rating}`);
            return rating;
        }
        
        rating = $('.AggregateRatingButton__RatingScore-sc-1ll29m0-1').first().text().trim();
        if (rating && !isNaN(parseFloat(rating))) {
            console.log(`IMDb rating (from aggregate score): ${rating}`);
            return rating;
        }
        
        rating = $('.ratingValue span[itemprop="ratingValue"]').first().text().trim();
        if (rating && !isNaN(parseFloat(rating))) {
            console.log(`IMDb rating (from rating value): ${rating}`);
            return rating;
        }
        
        const ratingMatch = imdbHtml.match(/aggregateRating"[^>]*"ratingValue":\s*"([^"]+)/);
        if (ratingMatch && ratingMatch[1] && !isNaN(parseFloat(ratingMatch[1]))) {
            console.log(`IMDb rating (from regex): ${ratingMatch[1]}`);
            return ratingMatch[1];
        }
        
        console.log("Could not find IMDb rating");
        return 'N/A';
    } catch (error) {
        console.error('IMDb rating error:', error);
        return 'N/A';
    }
}

// Separate Rotten Tomatoes scraper function
async function fetchRottenTomatoesRating(query) {
    console.log(`Fetching RT rating for: ${query}`);
    
    try {
        const omdbApiKey = process.env.OMDB_API_KEY;
        try {
            const omdbResponse = await axios.get(`http://www.omdbapi.com/?t=${encodeURIComponent(query)}&apikey=${omdbApiKey}`);
            
            if (omdbResponse.data.Response === "True" && omdbResponse.data.Ratings) {
                const rtRating = omdbResponse.data.Ratings.find(r => r.Source === "Rotten Tomatoes");
                if (rtRating && rtRating.Value) {
                    console.log(`RT rating from OMDB: ${rtRating.Value}`);
                    return rtRating.Value;
                }
            }
        } catch (err) {
            console.error("OMDB approach failed:", err.message);
        }
        
        let formattedTitle = query.toLowerCase()
            .replace(/\([0-9]{4}\)/, '')
            .trim()
            .replace(/[^\w\s]/g, '')
            .replace(/\s+/g, '_');
            
        const rtUrl = `https://www.rottentomatoes.com/m/${formattedTitle}`;
        console.log(`Trying direct RT URL: ${rtUrl}`);
        
        const response = await axios.get(rtUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 5000
        });
        
        const html = response.data;
        const $ = cheerio.load(html);
        
        let score = $('rt-text[slot="criticsScore"]').first().text().trim();
        console.log(`Found score from rt-text element: ${score}`);
        
        if (score && score.includes('%')) {
            return score;
        }
        
        score = $('a.tooltip.display-rating').text().trim() || 
                $('a[href$="/ratings/"]').text().trim() ||
                $('.average-rating').text().trim() ||
                $('.rating-histogram-descriptor .average-rating').text().trim();
                
        console.log(`Rating from alternative selectors: ${score}`);
        
        if (score) {
            return score;
        }
        
        score = $('meta[name="twitter:data2"]').attr('content');
        if (score && score.includes('out of 5')) {
            const match = score.match(/([0-9.]+) out of 5/);
            if (match && match[1]) {
                console.log(`Rating from meta tag: ${match[1]}`);
                return `${match[1]}%`;
            }
        }
        
        const scriptContent = $('script[type="application/ld+json"]').html();
        if (scriptContent) {
            try {
                const jsonData = JSON.parse(scriptContent);
                if (jsonData.aggregateRating && jsonData.aggregateRating.ratingValue) {
                    console.log(`Rating from JSON-LD: ${jsonData.aggregateRating.ratingValue}`);
                    return jsonData.aggregateRating.ratingValue.toString();
                }
            } catch (e) {
                console.error("Error parsing JSON-LD:", e.message);
            }
        }
        
        const pageText = $('body').text();
        const ratingMatches = pageText.match(/([0-9]\.[0-9]) out of 5/);
        if (ratingMatches && ratingMatches[1]) {
            console.log(`Rating from text pattern: ${ratingMatches[1]}`);
            return ratingMatches[1];
        }
        
        console.log("Could not find Letterboxd rating");
        return 'N/A';
    } catch (error) {
        console.error('Letterboxd rating error:', error.message);
        return 'N/A';
    }
}

// Separate Letterboxd scraper function
async function fetchLetterboxdRating(query) {
    console.log(`Fetching Letterboxd rating for: ${query}`);
    
    try {
        const formattedMovieName = query.toLowerCase()
            .replace(/\s*\(\d{4}\)\s*/, '')
            .replace(/[^\w\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-');
            
        const directUrl = `https://letterboxd.com/film/${formattedMovieName}/`;
        console.log(`Trying direct Letterboxd URL: ${directUrl}`);
        
        let movieUrl;
        let movieHtml;
        
        try {
            const directResponse = await axios.get(directUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                timeout: 5000
            });
            
            movieUrl = directUrl;
            movieHtml = directResponse.data;
            console.log("Direct URL approach successful");
        } catch (directError) {
            console.log("Direct URL failed, trying search");
            
            const searchUrl = `https://letterboxd.com/search/films/${encodeURIComponent(query)}/`;
            
            const searchResponse = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });
            
            const $ = cheerio.load(searchResponse.data);
            
            const firstResult = $('.results li.film').first();
            if (firstResult.length > 0) {
                const filmLink = firstResult.find('.film-poster').attr('data-target-link') || 
                                firstResult.find('.film-poster a').attr('href') ||
                                firstResult.find('h2.title a').attr('href');
                                
                if (filmLink) {
                    movieUrl = `https://letterboxd.com${filmLink}`;
                    
                    const movieResponse = await axios.get(movieUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            'Accept-Language': 'en-US,en;q=0.9'
                        }
                    });
                    
                    movieHtml = movieResponse.data;
                    console.log("Search approach successful");
                }
            } else {
                console.log("Letterboxd search failed, trying Google");
                
                const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(query + ' letterboxd rating')}`;
                const googleResponse = await axios.get(googleSearchUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept-Language': 'en-US,en;q=0.9'
                    }
                });
                
                const $g = cheerio.load(googleResponse.data);
                
                let letterboxdUrl;
                $g('a').each((i, link) => {
                    const href = $g(link).attr('href');
                    if (href && href.includes('letterboxd.com/film/')) {
                        letterboxdUrl = href.match(/url\?q=([^&]+)/)?.[1] || href;
                        return false;
                    }
                });
                
                if (letterboxdUrl) {
                    try {
                        const lbResponse = await axios.get(letterboxdUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                                'Accept-Language': 'en-US,en;q=0.9'
                            }
                        });
                        
                        movieHtml = lbResponse.data;
                        movieUrl = letterboxdUrl;
                        console.log("Google search approach successful");
                    } catch (googleError) {
                        console.error("Error fetching from Google link:", googleError.message);
                    }
                }
            }
        }
        
        if (!movieHtml) {
            console.log("Could not find movie page on Letterboxd");
            return 'N/A';
        }
        
        const $ = cheerio.load(movieHtml);
        
        let rating = $('a.tooltip.display-rating').text().trim();
        console.log(`Rating from tooltip display-rating: ${rating}`);
        
        if (rating) {
            return rating;
        }
        
        rating = $('.display-rating').text().trim() || 
                $('a[href$="/ratings/"]').text().trim() ||
                $('.average-rating').text().trim() ||
                $('.rating-histogram-descriptor .average-rating').text().trim();
                
        console.log(`Rating from alternative selectors: ${rating}`);
        
        if (rating) {
            return rating;
        }
        
        rating = $('meta[name="twitter:data2"]').attr('content');
        if (rating && rating.includes('out of 5')) {
            const match = rating.match(/([0-9.]+) out of 5/);
            if (match && match[1]) {
                console.log(`Rating from meta tag: ${match[1]}`);
                return match[1];
            }
        }
        
        const scriptContent = $('script[type="application/ld+json"]').html();
        if (scriptContent) {
            try {
                const jsonData = JSON.parse(scriptContent);
                if (jsonData.aggregateRating && jsonData.aggregateRating.ratingValue) {
                    console.log(`Rating from JSON-LD: ${jsonData.aggregateRating.ratingValue}`);
                    return jsonData.aggregateRating.ratingValue.toString();
                }
            } catch (e) {
                console.error("Error parsing JSON-LD:", e.message);
            }
        }
        
        const pageText = $('body').text();
        const ratingMatches = pageText.match(/([0-9]\.[0-9]) out of 5/);
        if (ratingMatches && ratingMatches[1]) {
            console.log(`Rating from text pattern: ${ratingMatches[1]}`);
            return ratingMatches[1];
        }
        
        console.log("Could not find Letterboxd rating");
        return 'N/A';
    } catch (error) {
        console.error('Letterboxd rating error:', error.message);
        return 'N/A';
    }
}

// Updated endpoint with better error handling
app.get('/api/movie/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Invalid movie ID' });

    console.log(`Fetching details for movie ID: ${id}`);
    const cacheKey = `movie_id:${id}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`Returning cached data for movie ID: ${id}`);
        return res.json(cached);
    }

    try {
        const apiKey = process.env.TMDB_API_KEY;
        
        console.log(`Fetching TMDB data for movie ID: ${id}`);
        const detailsUrl = `https://api.themoviedb.org/3/movie/${id}?api_key=${apiKey}&append_to_response=videos`;
        const { data: movieData } = await axios.get(detailsUrl);
        
        console.log(`Retrieved TMDB data for: ${movieData.title} (${movieData.release_date})`);
        
        let trailer = null;
        if (movieData.videos && movieData.videos.results) {
            const trailerVideo = movieData.videos.results.find(v => v.site === 'YouTube' && v.type === 'Trailer');
            if (trailerVideo) {
                trailer = `https://www.youtube.com/embed/${trailerVideo.key}`;
                console.log(`Found trailer: ${trailer}`);
            } else {
                console.log('No trailer found in video results');
            }
        } else {
            console.log('No videos data available');
        }
        
        console.log(`Getting ratings for: ${movieData.title}`);
        
        let imdbRatingValue = 'N/A';
        try {
            imdbRatingValue = await fetchIMDbRating(movieData.title);
            console.log(`IMDb rating: ${imdbRatingValue}`);
        } catch (imdbError) {
            console.error('Error getting IMDb rating:', imdbError);
        }
        
        let rtRatingValue = 'N/A';
        try {
            rtRatingValue = await fetchRottenTomatoesRating(movieData.title);
            console.log(`RT rating: ${rtRatingValue}`);
        } catch (rtError) {
            console.error('Error getting RT rating:', rtError);
        }
        
        let lbRatingValue = 'N/A';
        try {
            lbRatingValue = await fetchLetterboxdRating(movieData.title);
            console.log(`Letterboxd rating: ${lbRatingValue}`);
        } catch (lbError) {
            console.error('Error getting Letterboxd rating:', lbError);
        }

        const movieInfo = {
            title: movieData.title,
            year: movieData.release_date?.split('-')[0] || 'Unknown',
            plot: movieData.overview || 'No plot available',
            poster: movieData.poster_path ? `https://image.tmdb.org/t/p/w500${movieData.poster_path}` : null,
            trailer: trailer,
            ratings: {
                imdb: imdbRatingValue,
                rottenTomatoes: rtRatingValue,
                letterboxd: lbRatingValue,
                tmdb: movieData.vote_average ? movieData.vote_average.toFixed(1) : 'N/A'
            }
        };

        console.log(`Caching and returning data for: ${movieData.title}`);
        cache.set(cacheKey, movieInfo);
        res.json(movieInfo);
    } catch (error) {
        console.error('Movie details error:', error.message);
        console.error('Stack trace:', error.stack);
        res.status(500).json({ error: 'Failed to fetch movie details: ' + error.message });
    }
});

// Update the /api/search endpoint
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
    }

    try {
        const apiKey = process.env.TMDB_API_KEY;
        const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl);

        if (data.results.length === 0) {
            return res.json({ 
                multipleResults: false,
                movies: [] 
            });
        }

        const movies = data.results.map(movie => ({
            id: movie.id,
            title: movie.title,
            year: movie.release_date ? movie.release_date.split('-')[0] : 'Unknown',
            poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null
        }));

        // Return the data in the format expected by the frontend
        res.json({
            multipleResults: movies.length > 1,
            movies: movies
        });
    } catch (error) {
        console.error('Error fetching movie search results:', error.message);
        res.status(500).json({ 
            error: 'Failed to fetch movie search results',
            details: error.message 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

module.exports = app;
