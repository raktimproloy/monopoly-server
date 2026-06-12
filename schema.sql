-- PostgreSQL Schema for Multiplayer Board Game

-- Drop tables if they exist for clean migrations
DROP TABLE IF EXISTS game_logs CASCADE;
DROP TABLE IF EXISTS game_rooms CASCADE;
DROP TABLE IF EXISTS board_templates CASCADE;

-- 1. Board Templates: Stores static board configurations (tiles, prices, colors)
CREATE TABLE board_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    board_data JSONB NOT NULL, -- JSON payload matching BoardData interface
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Game Rooms: Stores active room states. Uses JSONB for robust, schema-less game state storage.
CREATE TABLE game_rooms (
    room_id VARCHAR(50) PRIMARY KEY,
    board_template_id INT REFERENCES board_templates(id),
    state JSONB NOT NULL, -- Authoritative game state (GameState interface)
    version INT NOT NULL DEFAULT 1, -- Optimistic concurrency lock
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Trigger to auto-update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_game_rooms_modtime
    BEFORE UPDATE ON game_rooms
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

-- 3. Game Logs: Stores history of actions taken in the game for replay and audit trails (anti-cheat verification)
CREATE TABLE game_logs (
    id BIGSERIAL PRIMARY KEY,
    room_id VARCHAR(50) REFERENCES game_rooms(room_id) ON DELETE CASCADE,
    player_id VARCHAR(50),
    action_type VARCHAR(100) NOT NULL,
    action_payload JSONB NOT NULL,
    state_snapshot JSONB NOT NULL, -- Snapshot of GameState after action
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Seed Standard Monopoly Board Template
INSERT INTO board_templates (name, board_data) VALUES (
    'Standard Monopoly',
    '{
        "tiles": [
            {"index": 0, "name": "GO", "type": "START"},
            {"index": 1, "name": "Mediterranean Avenue", "type": "STREET", "price": 60, "rent": [2, 10, 30, 90, 160, 250], "mortgageValue": 30, "houseCost": 50, "group": "Brown"},
            {"index": 2, "name": "Community Chest", "type": "CHEST"},
            {"index": 3, "name": "Baltic Avenue", "type": "STREET", "price": 60, "rent": [4, 20, 60, 180, 320, 450], "mortgageValue": 30, "houseCost": 50, "group": "Brown"},
            {"index": 4, "name": "Income Tax", "type": "TAX", "price": 200},
            {"index": 5, "name": "Reading Railroad", "type": "RAILROAD", "price": 200, "rent": [25, 50, 100, 200], "mortgageValue": 100},
            {"index": 6, "name": "Oriental Avenue", "type": "STREET", "price": 100, "rent": [6, 30, 90, 270, 400, 550], "mortgageValue": 50, "houseCost": 50, "group": "Light Blue"},
            {"index": 7, "name": "Chance", "type": "CHANCE"},
            {"index": 8, "name": "Vermont Avenue", "type": "STREET", "price": 100, "rent": [6, 30, 90, 270, 400, 550], "mortgageValue": 50, "houseCost": 50, "group": "Light Blue"},
            {"index": 9, "name": "Connecticut Avenue", "type": "STREET", "price": 120, "rent": [8, 40, 100, 300, 450, 600], "mortgageValue": 60, "houseCost": 50, "group": "Light Blue"},
            {"index": 10, "name": "Just Visiting / Jail", "type": "JAIL"},
            {"index": 11, "name": "St. Charles Place", "type": "STREET", "price": 140, "rent": [10, 50, 150, 450, 625, 750], "mortgageValue": 70, "houseCost": 100, "group": "Pink"},
            {"index": 12, "name": "Electric Company", "type": "UTILITY", "price": 150, "rent": [4, 10], "mortgageValue": 75},
            {"index": 13, "name": "States Avenue", "type": "STREET", "price": 140, "rent": [10, 50, 150, 450, 625, 750], "mortgageValue": 70, "houseCost": 100, "group": "Pink"},
            {"index": 14, "name": "Virginia Avenue", "type": "STREET", "price": 160, "rent": [12, 60, 180, 500, 700, 900], "mortgageValue": 80, "houseCost": 100, "group": "Pink"},
            {"index": 15, "name": "Pennsylvania Railroad", "type": "RAILROAD", "price": 200, "rent": [25, 50, 100, 200], "mortgageValue": 100},
            {"index": 16, "name": "St. James Place", "type": "STREET", "price": 180, "rent": [14, 70, 200, 550, 750, 950], "mortgageValue": 90, "houseCost": 100, "group": "Orange"},
            {"index": 17, "name": "Community Chest", "type": "CHEST"},
            {"index": 18, "name": "Tennessee Avenue", "type": "STREET", "price": 180, "rent": [14, 70, 200, 550, 750, 950], "mortgageValue": 90, "houseCost": 100, "group": "Orange"},
            {"index": 19, "name": "New York Avenue", "type": "STREET", "price": 200, "rent": [16, 80, 220, 600, 800, 1000], "mortgageValue": 100, "houseCost": 100, "group": "Orange"},
            {"index": 20, "name": "Free Parking", "type": "FREE_PARKING"},
            {"index": 21, "name": "Kentucky Avenue", "type": "STREET", "price": 220, "rent": [18, 90, 250, 700, 875, 1050], "mortgageValue": 110, "houseCost": 150, "group": "Red"},
            {"index": 22, "name": "Chance", "type": "CHANCE"},
            {"index": 23, "name": "Indiana Avenue", "type": "STREET", "price": 220, "rent": [18, 90, 250, 700, 875, 1050], "mortgageValue": 110, "houseCost": 150, "group": "Red"},
            {"index": 24, "name": "Illinois Avenue", "type": "STREET", "price": 240, "rent": [20, 100, 300, 750, 925, 1100], "mortgageValue": 120, "houseCost": 150, "group": "Red"},
            {"index": 25, "name": "B. & O. Railroad", "type": "RAILROAD", "price": 200, "rent": [25, 50, 100, 200], "mortgageValue": 100},
            {"index": 26, "name": "Atlantic Avenue", "type": "STREET", "price": 260, "rent": [22, 110, 330, 800, 975, 1150], "mortgageValue": 130, "houseCost": 150, "group": "Yellow"},
            {"index": 27, "name": "Ventnor Avenue", "type": "STREET", "price": 260, "rent": [22, 110, 330, 800, 975, 1150], "mortgageValue": 130, "houseCost": 150, "group": "Yellow"},
            {"index": 28, "name": "Water Works", "type": "UTILITY", "price": 150, "rent": [4, 10], "mortgageValue": 75},
            {"index": 29, "name": "Marvin Gardens", "type": "STREET", "price": 280, "rent": [24, 120, 360, 850, 1025, 1200], "mortgageValue": 140, "houseCost": 150, "group": "Yellow"},
            {"index": 30, "name": "Go To Jail", "type": "GO_TO_JAIL"},
            {"index": 31, "name": "Pacific Avenue", "type": "STREET", "price": 300, "rent": [26, 130, 390, 900, 1100, 1275], "mortgageValue": 150, "houseCost": 200, "group": "Green"},
            {"index": 32, "name": "North Carolina Avenue", "type": "STREET", "price": 300, "rent": [26, 130, 390, 900, 1100, 1275], "mortgageValue": 150, "houseCost": 200, "group": "Green"},
            {"index": 33, "name": "Community Chest", "type": "CHEST"},
            {"index": 34, "name": "Pennsylvania Avenue", "type": "STREET", "price": 320, "rent": [28, 150, 450, 1000, 1200, 1400], "mortgageValue": 160, "houseCost": 200, "group": "Green"},
            {"index": 35, "name": "Short Line Railroad", "type": "RAILROAD", "price": 200, "rent": [25, 50, 100, 200], "mortgageValue": 100},
            {"index": 36, "name": "Chance", "type": "CHANCE"},
            {"index": 37, "name": "Park Place", "type": "STREET", "price": 350, "rent": [35, 175, 500, 1100, 1300, 1500], "mortgageValue": 175, "houseCost": 200, "group": "Dark Blue"},
            {"index": 38, "name": "Luxury Tax", "type": "TAX", "price": 100},
            {"index": 39, "name": "Boardwalk", "type": "STREET", "price": 400, "rent": [50, 200, 600, 1400, 1700, 2000], "mortgageValue": 200, "houseCost": 200, "group": "Dark Blue"}
        ]
    }'::jsonb
) ON CONFLICT (name) DO NOTHING;
