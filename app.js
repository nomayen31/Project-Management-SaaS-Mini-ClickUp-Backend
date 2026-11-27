import express from "express";
import { createVercelApp } from "./dist/app.js";

export default createVercelApp(express());
