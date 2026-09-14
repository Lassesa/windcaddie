require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Alustetaan tietokanta ja Meri-Toppilan kaikki 18 väylää
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS courses (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        lat NUMERIC(7, 4) NOT NULL,
        lon NUMERIC(7, 4) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS holes (
        id SERIAL PRIMARY KEY,
        course_id INT REFERENCES courses(id) ON DELETE CASCADE,
        hole_number INT NOT NULL,
        par INT NOT NULL,
        length_meters INT,
        throw_direction_deg INT NOT NULL
      );
    `);

    // Tarkistetaan onko kanta tyhjä, ja lisätään testirata (Meri-Toppila)
    const courseCheck = await pool.query('SELECT * FROM courses');
    let courseId;

    if (courseCheck.rows.length === 0) {
      const courseRes = await pool.query(
        'INSERT INTO courses (name, lat, lon) VALUES ($1, $2, $3) RETURNING id',
        ['Meri-Toppila DiscGolfPark, Oulu', 65.0530, 25.4260]
      );
      courseId = courseRes.rows[0].id;
      console.log('Testirata (Meri-Toppila) luotu tietokantaan!');
    } else {
      courseId = courseCheck.rows[0].id;
    }

    // Päivitetään tai lisätään kaikki 18 väylää suuntakulmineen
    await pool.query('DELETE FROM holes WHERE course_id = $1', [courseId]);

    const holesData = [
      { number: 1, par: 3, length: 112, direction: 280 },
      { number: 2, par: 3, length: 90, direction: 350 },
      { number: 3, par: 3, length: 110, direction: 15 },
      { number: 4, par: 3, length: 63, direction: 200 },
      { number: 5, par: 3, length: 71, direction: 350 },
      { number: 6, par: 3, length: 108, direction: 270 },
      { number: 7, par: 3, length: 86, direction: 100 },
      { number: 8, par: 3, length: 116, direction: 260 },
      { number: 9, par: 4, length: 185, direction: 280 },
      { number: 10, par: 3, length: 89, direction: 220 },
      { number: 11, par: 3, length: 100, direction: 170 },
      { number: 12, par: 3, length: 93, direction: 350 },
      { number: 13, par: 3, length: 92, direction: 160 },
      { number: 14, par: 3, length: 73, direction: 210 },
      { number: 15, par: 3, length: 94, direction: 350 },
      { number: 16, par: 3, length: 111, direction: 130 },
      { number: 17, par: 3, length: 83, direction: 150 },
      { number: 18, par: 3, length: 117, direction: 150 }
    ];

    for (const h of holesData) {
      await pool.query(
        'INSERT INTO holes (course_id, hole_number, par, length_meters, throw_direction_deg) VALUES ($1, $2, $3, $4, $5)',
        [courseId, h.number, h.par, h.length, h.direction]
      );
    }

    console.log('Kaikki 18 väylää päivitetty tietokantaan!');
    console.log('Tietokanta valmiina.');
  } catch (err) {
    console.error('Virhe tietokannan alustuksessa:', err);
  }
}

// API: Hae radat
app.get('/api/courses', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM courses');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Virhe ratojen haussa' });
  }
});

// API: Hae tietyn radan väylät
app.get('/api/courses/:id/holes', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM holes WHERE course_id = $1 ORDER BY hole_number ASC', [id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Virhe väylien haussa' });
  }
});

// Vektorilaskenta: Laskee tuulen vaikutuksen suhteessa heittosuuntaan
function getWindRelation(windDirDeg, throwDirDeg) {
    let diff = (windDirDeg - throwDirDeg + 360) % 360;

    if (diff >= 337.5 || diff < 22.5) return { type: "Suora vastatuuli", advice: "Kiekko nousee ja feidaa aikaisemmin. Ota vakaampi lätty." };
    if (diff >= 22.5 && diff < 67.5) return { type: "Vastainen sivutuuli oikealta", advice: "Painaa vasemmalle ja nostaa kiekkoa. Huomioi sivuttaissiirtymä." };
    if (diff >= 67.5 && diff < 112.5) return { type: "Sivutuuli oikealta", advice: "Työntää kiekkoa voimakkaasti vasemmalle. Heitä hallitulla hyssellä." };
    if (diff >= 112.5 && diff < 157.5) return { type: "Myötäinen sivutuuli oikealta", advice: "Painaa hieman alas ja vasemmalle." };
    if (diff >= 157.5 && diff < 202.5) return { type: "Suora myötätuuli", advice: "Kiekko laskeutuu pidemmälle, mutta voi kääntää yli. Valitse hieman hitaampi/vakaampi." };
    if (diff >= 202.5 && diff < 247.5) return { type: "Myötäinen sivutuuli vasemmalta", advice: "Painaa hieman alas ja oikealle." };
    if (diff >= 247.5 && diff < 292.5) return { type: "Sivutuuli vasemmalta", advice: "Työntää kiekkoa voimakkaasti oikealle (RHBH ansaa helposti yli)." };
    if (diff >= 292.5 && diff < 337.5) return { type: "Vastainen sivutuuli vasemmalta", advice: "Nostaa ja painaa oikealle. Vaatii tarkkaa kulman hallintaa." };
    
    return { type: "Vaihteleva tuuli", advice: "Pelaa varman päälle." };
}

// Päivitetty API-reitti, joka yhdistää sään ja laskee väyläkohtaisen tuulen
app.get('/api/courses/:id/weather', async (req, res) => {
  try {
    const courseId = req.params.id;

    const courseResult = await pool.query('SELECT * FROM courses WHERE id = $1', [courseId]);
    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Rataa ei löytynyt' });
    }
    const course = courseResult.rows[0];

    const holesResult = await pool.query('SELECT * FROM holes WHERE course_id = $1 ORDER BY hole_number ASC', [courseId]);
    
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${course.lat}&longitude=${course.lon}&hourly=temperature_2m,wind_direction_10m,wind_speed_10m,wind_gusts_10m&wind_speed_unit=ms&forecast_days=1`;
    const weatherRes = await axios.get(weatherUrl);
    
    const currentWeather = {
      temperature: weatherRes.data.hourly.temperature_2m[0],
      windSpeed: weatherRes.data.hourly.wind_speed_10m[0],
      windDirection: weatherRes.data.hourly.wind_direction_10m[0],
      windGusts: weatherRes.data.hourly.wind_gusts_10m[0]
    };

    // Lasketaan jokaiselle väylälle tuilianalyysi
    const analyzedHoles = holesResult.rows.map(hole => {
      const windAnalysis = getWindRelation(currentWeather.windDirection, hole.throw_direction_deg);
      return {
        ...hole,
        windAnalysis
      };
    });

    res.json({
      course: course.name,
      currentWeather,
      holes: analyzedHoles
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Virhe tiedon haussa' });
  }
});

async function startServer() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`DiscGolf Wind Caddie -palvelin käynnissä portissa ${PORT}`);
  });
}

startServer();