#!/usr/bin/env node
/**
 * Video Clip Database Registration Script
 * Registers every deployed action-sequence video clip.
 */

const path = require('path');
const db = require('./db');
const { videoClipsData, registerAllVideos } = require('./register-videos');

async function main() {
    console.log('\n🎬 Toloka - VIDEO TASK REGISTRATION');
    console.log('=====================================\n');

    try {
        // Ensure database is ready
        console.log('📊 Connecting to database...');
        
        const result = await registerAllVideos(db);
        
        console.log('\n✅ VIDEO REGISTRATION COMPLETE');
        console.log(`📺 Registered videos: ${result.successCount}`);
        console.log(`🎯 Failed registrations: ${result.errorCount}`);
        
        if (result.successCount > 0) {
        console.log('\n📋 Registered videos are now available as task options:');
            result.registeredVideos.forEach((video, i) => {
                console.log(`   ${i + 1}. ${video.title} (${video.difficulty})`);
            });
        }

        console.log('\n🚀 Next steps:');
        console.log('   1. Restart the server: npm start');
        console.log('   2. Try "Action Sequence Identification" task type');
        console.log('   3. Videos will be served from /api/video/:videoId/stream\n');
        
        process.exit(result.errorCount === 0 ? 0 : 1);

    } catch (error) {
        console.error('\n❌ Registration failed:', error.message);
        process.exit(1);
    }
}

main();

