import express from "express"
import { MongoClient } from 'mongodb'
import dotenv from 'dotenv'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import authMiddleware from './auth.js'
import cors from 'cors'
import bodyParser from 'body-parser'
import multer from "multer"
import sharp from "sharp"
import { v4 as uuidv4 } from 'uuid';
import { bucket } from "./firebase.js"

//for auto-cleanup data after certain time
import cron from 'node-cron';


dotenv.config()

const mongourl = process.env.MONGO_URL
// for local
const client = new MongoClient(mongourl)

// for production
// const client = new MongoClient(mongourl, {
//     tls: true,  // Enable TLS
//     tlsInsecure: true,  // Ensure certificates are validated
//     connectTimeoutMS: 10000,
// })
const dbName = 'selectify'
const app = express()
const port = process.env.PORT || 3000;
await client.connect()

// Function to drop existing index and create new TTL indexes
async function createIndexes() {
    const db = client.db(dbName);

    // Drop existing TTL index if it exists
    try {
        const indexes = await db.collection('photos').indexes();
        const existingIndex = indexes.find(index => index.name === 'createdAt_1');
        if (existingIndex) {
            await db.collection('photos').dropIndex('createdAt_1');
        }
    } catch (error) {
        // console.error('Error dropping existing index for photos collection:', error);
    }

    try {
        const indexes = await db.collection('photoLinks').indexes();
        const existingIndex = indexes.find(index => index.name === 'createdAt_1');
        if (existingIndex) {
            await db.collection('photoLinks').dropIndex('createdAt_1');
        }
    } catch (error) {
        // console.error('Error dropping existing index for photoLinks collection:', error);
    }

    // Create TTL index on `photos` collection
    await db.collection('photos').createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 172800 } // 2 days in seconds-172800
    );

    // Create TTL index on `photoLinks` collection
    await db.collection('photoLinks').createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 172800 } // 2 days in seconds
    );

    console.log('TTL indexes created');
}

// Initialize TTL indexes
createIndexes().catch(console.error);

// delete file from firebase after 2 days
const deleteOldFiles = async () => {
    try {
        // Connect to MongoDB
        const db = client.db(dbName);
        const collection = db.collection('photos');

        // Find files older than 2 days
        const files = await collection.find({
            createdAt: { $lt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } // 2 days ago-2 * 24 * 60 * 60 * 1000
        }).toArray();

        for (const file of files) {
            // Construct the file reference from the URL
            const fileRef = bucket.file(file.photoUrl.split('/').pop());

            // Delete the file from Firebase Storage
            await fileRef.delete();


        }

        console.log('Old files deleted successfully');
    } catch (error) {
        console.error('Error deleting old files:', error);
    }
};
// cron.schedule('*/2 * * * *', deleteOldFiles);   // for two minutes
// Schedule the cleanup job to run every day at midnight
cron.schedule('0 0 * * *', deleteOldFiles);

// for local
app.use(cors());

//for production
// app.use(cors({
//     origin: 'https://eventoz.netlify.app', // Specify your frontend domain
//     methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
//     credentials: true // Allow cookies or other credentials to be sent
// }));
// app.options('*', cors()); // Preflight response to all routes

app.use(bodyParser.json())

// Multer setup for file uploads
const storage = multer.memoryStorage(); // Store files in memory
const upload = multer({ storage: storage });

// register 
app.post("/register", async (request, response) => {
    try {
        const hashedPassword = await bcrypt.hash(request.body.password, 10);
        const db = client.db(dbName);
        const collection = db.collection('users');
        const user = {
            email: request.body.email,
            password: hashedPassword,
        }

        const alreadyExist = await collection.findOne({ email: request.body.email })

        if (alreadyExist) {
            return response.status(409).send({
                message: "User with this email already exists",
            });
        }

        const result = await collection.insertOne(user);
        response.status(201).send({
            message: "User Created Successfully",
            result,
        });


    } catch (error) {
        response.status(500).send({
            message: "Error creating user",
            error,
        });
    }

});

//login
app.post("/login", async (request, response) => {
    try {
        const db = client.db(dbName);
        const collection = db.collection('users');
        const user = await collection.findOne({ email: request.body.email });
        if (!user) {
            return response.status(404).send({
                message: "Email not found",
            });
        }
        const match = await bcrypt.compare(request.body.password, user.password);

        if (!match) {
            return response.status(401).send({
                message: "Invalid password",
            });
        }

        const token = jwt.sign(
            {
                userId: user._id,
                userEmail: user.email,
            },
            "RANDOM-TOKEN",
            { expiresIn: "24h" }
        );
        response.status(200).send({
            message: "Login successful",
            user: {
                email: user.email,
                token,
            }
        });

    } catch (error) {
        response.status(404).send({
            message: "Email not found",
            error,
        });
    }
})

app.get('/', (req, res) => {
    res.send('Hello World!')
})

app.post('/api/upload', authMiddleware, upload.array('photos'), async (req, res) => {
    try {
        const userId = req.userId;  // get userId from token
        const photos = req.files;   // contain uploaded photos
        const originalFileNames = JSON.parse(req.body.originalFileNames); // Parse JSON string & It contain the original names of the uploaded files
        const { name } = req.body;

        if (!name) {
            return res.status(400).send({ message: 'Name is required' });
        }

        if (!Array.isArray(originalFileNames) || originalFileNames.length !== photos.length) {
            return res.status(400).send({ message: 'Original file names are missing or incorrect' });
        }

        const photoData = await Promise.all(photos.map(async (photo, index) => {
            const resizedPhotoBuffer = await sharp(photo.buffer)

                .jpeg({ quality: 20 })
                .toBuffer();

            const photoName = `${uuidv4()}*${originalFileNames[index]}`; // Unique identifier + original name
            const file = bucket.file(photoName);

            await file.save(resizedPhotoBuffer, {
                metadata: { contentType: 'image/jpeg' },
                public: true,
            });

            const photoUrl = file.publicUrl();

            // Save photo metadata in MongoDB
            const db = client.db(dbName);
            const collection = db.collection('photos');
            await collection.insertOne({
                userId,     // got from token & will be same for each entry
                photoUrl,   // it is the public url of the photos
                originalFileName: originalFileNames[index], // Store the original file name
                name,       // name given by user & will be same for the set of photos uploaded
                views: 0,
                createdAt: new Date(),
            });

            return {
                photoUrl,
                originalFileName: originalFileNames[index],
                isSelected: false,
                id: uuidv4(),
            };
        }));

        const uniqueId = uuidv4();
        const link = `/gallery/${uniqueId}`;

        const db = client.db(dbName);
        const collection = db.collection('photoLinks');
        await collection.insertOne({
            name,
            uniqueId,
            visitCount: 0,
            photos: photoData,
            createdAt: new Date(),
        });

        res.status(200).send({ message: 'Photos uploaded successfully', photoData, link });
    } catch (error) {
        // console.error('Upload Error:', error); // Log detailed error
        res.status(500).send({ message: 'Error uploading photos', error: error.message });
    }
});

// Get Photos by Link
app.get('/gallery/:uniqueId', async (req, res) => {
    try {
        const { uniqueId } = req.params;
        const db = client.db(dbName);
        const collection = db.collection('photoLinks');

        // Find the document by uniqueId
        const photoLink = await collection.findOne({ uniqueId });

        if (!photoLink) {
            return res.status(404).send({ message: 'Link not found' });
        }

        // Send the document back to the client
        res.status(200).send({
            name: photoLink.name,
            uniqueId: photoLink.uniqueId,
            photos: photoLink.photos.map(photo => ({
                photoUrl: photo.photoUrl,
                originalFileName: photo.originalFileName,
                isSelected: photo.isSelected,
                uniquePhotoId: photo.id
            })),
            createdAt: photoLink.createdAt,
        });
    } catch (error) {
        // console.error('Error retrieving photos:', error);
        res.status(500).send({ message: 'Error retrieving photos', error: error.message });
    }
});

// Endpoint to update photo selection status
app.put('/photolinks/:originalFileName/:id/:uniqueID/select', async (req, res) => {
    // console.log(req.params);
    const { originalFileName, id, uniqueID } = req.params;
    const { isSelected } = req.body; // Get the new selection state from the request body
    const db = client.db(dbName);
    const collection = db.collection('photoLinks');

    try {
        // Find the document with the given uniqueID
        const photoLink = await collection.findOne({ uniqueId: uniqueID });

        if (!photoLink) {
            return res.status(404).json({ message: 'PhotoLink not found' });
        }

        // Update the `isSelected` attribute of the specific photo
        const updateResult = await collection.updateOne(
            { 'photos.id': id, 'photos.originalFileName': originalFileName, uniqueId: uniqueID },
            { $set: { 'photos.$.isSelected': isSelected } } // Set to the new selection state
        );

        if (updateResult.modifiedCount === 0) {
            return res.status(404).json({ message: 'Photo not found or selection state not changed' });
        }

        res.status(200).json({ message: 'Photo selection updated successfully' });
    } catch (error) {
        // console.error('Error updating photo selection:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// Endpoint used to show cards on dashboard
app.get('/gallery', async (req, res) => {
    const db = client.db(dbName);
    const collection = db.collection('photoLinks');

    try {
        const photoLinks = await collection.find({}).toArray();
        res.status(200).json(photoLinks);
    } catch (error) {
        // console.error('Error fetching photo links:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});


// Endpoint which show photos in user link
app.get('/gallery/show/:uniqueId', async (req, res) => {
    try {
        const { uniqueId } = req.params;
        const db = client.db(dbName);
        const collection = db.collection('photoLinks');

        // Find the document by uniqueId
        const photoLink = await collection.findOne({ uniqueId });

        if (!photoLink) {
            return res.status(404).send({ message: 'Link not found' });
        }

        // Check visit count
        if (photoLink.visitCount > 2) {
            return res.status(403).send({ message: 'Link has been visited too many times' });
        }

        // Increment the visit count
        await collection.updateOne(
            { uniqueId },
            { $inc: { visitCount: 1 } }
        );

        // Send the document back to the client
        res.status(200).send({
            name: photoLink.name,
            uniqueId: photoLink.uniqueId,
            photos: photoLink.photos.map(photo => ({
                photoUrl: photo.photoUrl,
                originalFileName: photo.originalFileName,
                isSelected: photo.isSelected,
                uniquePhotoId: photo.id
            })),
            createdAt: photoLink.createdAt,
        });
    } catch (error) {
        // console.error('Error retrieving photos:', error);
        res.status(500).send({ message: 'Error retrieving photos', error: error.message });
    }
});






// for production
// app.listen(port, '0.0.0.0', () => {
//     console.log(`Example app listening on port ${port}`);
// });

// for local
app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});



// free endpoint
app.get("/free-endpoint", (request, response) => {
    response.json({ message: "You are free to access me anytime" });
});

// authentication endpoint
app.get("/auth-endpoint", authMiddleware, (request, response) => {
    response.json({ message: "You are authorized to access me" });
});