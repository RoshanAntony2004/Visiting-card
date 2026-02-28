-- Setup database (You should run this specifically in the 'postgres' default database or create it via pgAdmin)
-- CREATE DATABASE visiting_card_ai;

-- Connect to visiting_card_ai database before running the below queries.

CREATE TABLE IF NOT EXISTS AI_Jobs (
    JobID SERIAL PRIMARY KEY,
    imageBase64 TEXT,
    Request VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS Customer_Data (
    CUST_ID SERIAL PRIMARY KEY,
    "Phn No (i18n)" VARCHAR(50),
    Name VARCHAR(255),
    Address TEXT,
    Product_Notes TEXT,
    photo_binary TEXT,
    BusinessType VARCHAR(100),
    JobID INT REFERENCES AI_Jobs(JobID)
);
