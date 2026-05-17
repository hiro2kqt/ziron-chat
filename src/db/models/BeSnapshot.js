/**
 * BeSnapshot Mongoose Model
 * Stores a single baseline snapshot of PM2 processes and Docker containers.
 * Always a singleton document — upserted with fixed _id 'singleton'.
 */

import mongoose from 'mongoose';

const pm2ProcessSchema = new mongoose.Schema({
  name:   { type: String, required: true },
  pid:    { type: Number, default: null },
  pm_id:  { type: Number, required: true },
  status: { type: String, required: true },
}, { _id: false });

const dockerContainerSchema = new mongoose.Schema({
  id:     { type: String, required: true },
  name:   { type: String, required: true },
  image:  { type: String, required: true },
  status: { type: String, required: true },
  health: { type: String, default: null },
}, { _id: false });

const beSnapshotSchema = new mongoose.Schema({
  _id:       { type: String, default: 'singleton' },
  createdAt: { type: Date, required: true },
  pm2:       { type: [pm2ProcessSchema], default: [] },
  docker:    { type: [dockerContainerSchema], default: [] },
}, { _id: false });

const BeSnapshot = mongoose.model('BeSnapshot', beSnapshotSchema);

export default BeSnapshot;
